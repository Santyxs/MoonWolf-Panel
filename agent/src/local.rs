use std::collections::HashMap;
use std::future::Future;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, Ordering},
};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};
use tracing::info;
use walkdir::WalkDir;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

use crate::{AppState, sleep_ms};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const UPLOAD_DIR_NAME: &str = ".moonwolf-uploads";
const UPLOAD_MAX_CHUNK: usize = 17 * 1024 * 1024;
const UPLOAD_BODY_LIMIT: usize = 20 * 1024 * 1024;

const BACKUPS_REL_DIR: &str = ".moonwolf/backups";
const BACKUP_EXCLUDES: &[&str] = &[".moonwolf", ".moonwolf-uploads"];
const BACKUP_RETENTION: usize = 10;

const PANEL_UA: &str = "MoonWolfPanel/2.0 (contact@moonwolf.local)";
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/* ══════════════════════════════════════════════
ESTADO
══════════════════════════════════════════════ */

#[derive(Clone)]
struct LocalState {
    app: Arc<RwLock<AppState>>,
    mc: Arc<RwLock<Option<Child>>>,
    lifecycle: Arc<Mutex<()>>,
    uploads: Arc<Mutex<HashMap<String, Arc<Mutex<UploadManifest>>>>>,
    backup_progress: Arc<Mutex<BackupProgress>>,
    backup_operation: Arc<Mutex<Option<String>>>,
    intentional_stop: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct UploadManifest {
    #[serde(default)]
    path: String,
    #[serde(default, rename = "totalSize")]
    total_size: u64,
    #[serde(default)]
    chunks: Vec<ChunkRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChunkRange {
    offset: u64,
    end: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupProgress {
    active: bool,
    phase: String,
    processed_bytes: u64,
    total_bytes: u64,
    percent: u32,
    started_at: Option<i64>,
    error: Option<String>,
}

pub async fn serve(app: Arc<RwLock<AppState>>, port: u16) -> anyhow::Result<()> {
    let state = LocalState {
        app,
        mc: Arc::new(RwLock::new(None)),
        lifecycle: Arc::new(Mutex::new(())),
        uploads: Arc::new(Mutex::new(HashMap::new())),
        backup_progress: Arc::new(Mutex::new(BackupProgress::default())),
        backup_operation: Arc::new(Mutex::new(None)),
        intentional_stop: Arc::new(AtomicBool::new(false)),
    };

    let router = Router::new()
        .route("/api/health", get(health))
        // Archivos
        .route("/api/files", get(list_files))
        .route(
            "/api/files/content",
            get(get_file_content).post(put_file_content),
        )
        .route("/api/files/download", get(download_file))
        .route("/api/files/delete", post(delete_files))
        .route("/api/files/create", post(create_file))
        .route("/api/files/upload-chunk", post(upload_chunk))
        .route("/api/files/rename", post(rename_file))
        .route("/api/files/copy", post(copy_file))
        .route("/api/files/move", post(move_file))
        .route("/api/files/compress", post(compress_file))
        .route("/api/files/bulk", post(bulk_action))
        // Servidor
        .route("/api/start", post(start_server))
        .route("/api/stop", post(stop_server))
        .route("/api/restart", post(restart_server))
        .route("/api/command", post(send_command))
        .route("/api/status", get(server_status))
        // Agente
        .route("/api/agent/state", get(agent_state))
        .route("/api/agent/logs/clear", post(clear_logs))
        // Backups
        .route("/api/backups", get(list_backups).post(create_backup))
        .route("/api/backups/progress", get(get_backup_progress))
        .route("/api/backups/download/{name}", get(download_backup))
        .route("/api/backups/{name}", delete(delete_backup))
        .route("/api/backups/{name}/restore", post(restore_backup))
        // Startup
        .route("/api/startup", get(get_startup).post(save_startup))
        .route("/api/startup/detect-version", post(detect_version))
        // Ports
        .route("/api/ports", get(get_ports).post(save_ports))
        // Versions
        .route("/api/versions/software", get(versions_software))
        .route("/api/versions/list", get(versions_list))
        .route("/api/versions/builds", get(versions_builds))
        .route("/api/versions/install", post(versions_install))
        // Plugins
        .route("/api/plugins/search", get(plugins_search))
        .route("/api/plugins/versions", get(plugins_versions))
        .route("/api/plugins/install", post(plugins_install))
        .route("/api/plugins/installed", get(plugins_installed))
        .route("/api/plugins/installed/{file}", delete(plugins_delete))
        // Databases
        .route("/api/databases/status", get(db_status))
        .route("/api/databases", get(db_list).post(db_create))
        .route("/api/databases/{name}/reset-password", post(db_reset))
        .route("/api/databases/{name}", delete(db_delete))
        .layer(DefaultBodyLimit::max(UPLOAD_BODY_LIMIT))
        .with_state(state.clone());

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    info!("API local en {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;

    let startup_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let (root, java_configured) = {
            let app = startup_state.app.read().await;
            (app.config.server_dir.clone(), app.config.java_path.clone())
        };

        if !load_startup_config(&root).await.auto_start_on_boot
            || startup_state.intentional_stop.load(Ordering::Acquire)
        {
            return;
        }

        let _lifecycle = startup_state.lifecycle.lock().await;
        if startup_state.intentional_stop.load(Ordering::Acquire)
            || startup_state.mc.read().await.is_some()
        {
            return;
        }

        match start_server_inner(startup_state.clone(), root, java_configured).await {
            Ok(_) if startup_state.mc.read().await.is_some() => {
                info!("Arranque automático de Minecraft completado.");
            }
            Ok(_) => {
                let mut app = startup_state.app.write().await;
                app.add_console_log("error", "El arranque automático no pudo iniciar Minecraft.");
            }
            Err(error) => {
                let mut app = startup_state.app.write().await;
                app.add_console_log("error", format!("Falló el arranque automático: {error}"));
            }
        }
    });

    axum::serve(listener, router).await?;
    Ok(())
}

pub async fn wait_ready(port: u16, max_attempts: u32) -> anyhow::Result<()> {
    let url = format!("http://127.0.0.1:{port}/api/health");
    let client = http_client();
    for attempt in 1..=max_attempts {
        if let Ok(resp) = client.get(&url).send().await
            && resp.status().is_success()
        {
            return Ok(());
        }
        sleep_ms((250 * attempt).min(1500) as u64).await;
    }
    anyhow::bail!("El servidor local de MoonWolf no respondió a tiempo")
}

/* ══════════════════════════════════════════════
HELPERS GENERALES
══════════════════════════════════════════════ */

fn check_auth(headers: &HeaderMap, expected: &str) -> Result<(), StatusCode> {
    // Nunca aceptar configuración sin token: un local_token vacío dejaría la API abierta.
    if expected.is_empty() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("Token "))
        .unwrap_or(auth);
    let alt = headers
        .get("x-moonwolf-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if (!token.is_empty() && token == expected) || (!alt.is_empty() && alt == expected) {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn json_ok(data: serde_json::Value) -> Response {
    let mut v = data;
    if let Some(obj) = v.as_object_mut() {
        obj.insert("ok".into(), json!(true));
    }
    Json(v).into_response()
}

fn json_fail(msg: &str) -> Response {
    Json(json!({ "ok": false, "error": msg })).into_response()
}

fn resolve_safe_sync(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // El explorador recibe rutas relativas a serverDir, aunque algunas
    // solicitudes incluyan una barra inicial.
    let rel = rel.trim_start_matches(['/', '\\']);
    let relative = Path::new(rel);

    // Rechazar el traversal léxico antes de resolver el sistema de archivos.
    // También bloquea prefijos de unidad y rutas absolutas que queden después
    // de normalizar la barra inicial.
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("Ruta no permitida".into());
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|_| "No se puede acceder a serverDir".to_string())?;
    let joined = canonical_root.join(relative);
    let mut existing = joined.clone();

    // Para permitir crear subdirectorios, subimos hasta el ancestro existente
    // más cercano. Se canonicaliza antes de aceptar para detectar enlaces
    // simbólicos que salgan de serverDir, incluso si el destino final no existe.
    loop {
        match existing.canonicalize() {
            Ok(canonical_existing) => {
                if !canonical_existing.starts_with(&canonical_root) {
                    return Err("Ruta no permitida".into());
                }

                let remainder = joined
                    .strip_prefix(&existing)
                    .map_err(|_| "Ruta no permitida".to_string())?;
                return Ok(canonical_existing.join(remainder));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Un enlace simbólico roto también debe rechazarse: de lo
                // contrario, al crear el destino podría resolver fuera de root.
                match std::fs::symlink_metadata(&existing) {
                    Ok(_) => return Err("Ruta no permitida".into()),
                    Err(metadata_error)
                        if metadata_error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err("Ruta no permitida".into()),
                }

                if existing == canonical_root || !existing.pop() {
                    return Err("No se puede resolver la ruta".into());
                }
            }
            Err(_) => return Err("Ruta no permitida".into()),
        }
    }
}

async fn resolve_safe(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = root.to_path_buf();
    let rel = rel.to_owned();
    tokio::task::spawn_blocking(move || resolve_safe_sync(&root, &rel))
        .await
        .map_err(|e| format!("tarea de ruta falló: {e}"))?
}

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(PANEL_UA)
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(60))
            .pool_max_idle_per_host(16)
            .build()
            .expect("reqwest client")
    })
}

async fn fetch_json(url: &str) -> Result<serde_json::Value, String> {
    let resp = http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json().await.map_err(|e| format!("JSON: {e}"))
}

async fn fetch_text(url: &str) -> Result<String, String> {
    let resp = http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.text().await.map_err(|e| format!("text: {e}"))
}

async fn download_to(url: &str, dest: &Path) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let mut resp = http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP: {e}"))?
        .error_for_status()
        .map_err(|e| format!("HTTP status: {e}"))?;

    if let Some(parent) = dest.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    // Temporal único por operación: dos descargas concurrentes del mismo
    // destino (p. ej. el mismo plugin) no deben compartir el mismo .part.
    let part = {
        let mut id = [0u8; 8];
        {
            use rand::Rng;
            rand::rng().fill_bytes(&mut id);
        }
        let id = id.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let base = dest
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("download");
        dest.with_file_name(format!("{base}.{id}.part"))
    };
    let _ = tokio::fs::remove_file(&part).await;

    let result = async {
        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| format!("create: {e}"))?;

        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("chunk: {e}"))? {
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write: {e}"))?;
        }
        file.flush().await.ok();
        drop(file);

        replace_file(&part, dest).await?;
        Ok(())
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    result
}

/// Sustituye `dest` por `src` de forma segura en Windows (rename sobre un
/// fichero existente suele fallar). Si el destino está bloqueado (p. ej. jar
/// en uso por Minecraft), se propaga el error.
async fn replace_file(src: &Path, dest: &Path) -> Result<(), String> {
    if src == dest {
        return Ok(());
    }
    if dest.exists() {
        // Apartar el anterior; si remove falla (archivo en uso), no dejamos
        // el temporal como destino final a medias.
        let backup = {
            let mut id = [0u8; 4];
            {
                use rand::Rng;
                rand::rng().fill_bytes(&mut id);
            }
            let id = id.iter().map(|b| format!("{b:02x}")).collect::<String>();
            let base = dest.file_name().and_then(|n| n.to_str()).unwrap_or("file");
            dest.with_file_name(format!("{base}.{id}.old"))
        };
        if let Err(e) = tokio::fs::rename(dest, &backup).await {
            return Err(format!(
                "No se pudo sustituir el archivo existente (¿en uso?): {e}"
            ));
        }
        if let Err(e) = tokio::fs::rename(src, dest).await {
            // Intentar devolver el original
            let _ = tokio::fs::rename(&backup, dest).await;
            return Err(format!("No se pudo mover el archivo descargado: {e}"));
        }
        let _ = tokio::fs::remove_file(&backup).await;
        return Ok(());
    }
    tokio::fs::rename(src, dest)
        .await
        .map_err(|e| format!("rename: {e}"))
}

/// Tamaño de chunk para descargas en streaming (archivos / backups).
const FILE_STREAM_CHUNK: usize = 256 * 1024;

/// Stream de bytes desde un fichero abierto, sin cargarlo entero en memoria.
fn file_byte_stream(
    file: tokio::fs::File,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send {
    use tokio::io::AsyncReadExt;
    futures_util::stream::unfold(file, |mut file| async move {
        let mut buf = bytes::BytesMut::with_capacity(FILE_STREAM_CHUNK);
        buf.resize(FILE_STREAM_CHUNK, 0);
        match file.read(&mut buf[..]).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(buf.freeze()), file))
            }
            Err(e) => Some((Err(e), file)),
        }
    })
}

fn semver_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<i64> = a.split('.').map(|s| s.parse().unwrap_or(0)).collect();
    let pb: Vec<i64> = b.split('.').map(|s| s.parse().unwrap_or(0)).collect();
    for i in 0..pa.len().max(pb.len()) {
        match pa
            .get(i)
            .copied()
            .unwrap_or(0)
            .cmp(&pb.get(i).copied().unwrap_or(0))
        {
            std::cmp::Ordering::Equal => continue,
            o => return o,
        }
    }
    std::cmp::Ordering::Equal
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/* ══════════════════════════════════════════════
ENDPOINTS BASE
══════════════════════════════════════════════ */

async fn health(State(st): State<LocalState>) -> impl IntoResponse {
    let s = st.app.read().await;
    let running = st.mc.read().await.is_some();
    Json(json!({
        "ok": true,
        "version": s.version,
        "agentId": s.config.agent_id,
        "localReady": s.local_ready,
        "cloudConnected": s.cloud_connected,
        "serverRunning": running,
    }))
}

async fn agent_state(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    Ok(Json(s.snapshot()).into_response())
}

async fn clear_logs(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let mut s = st.app.write().await;
    check_auth(&headers, &s.config.local_token)?;
    s.console_logs.clear();
    s.add_console_log("info", "Consola del servidor limpiada");
    Ok(json_ok(json!({})))
}

/* ══════════════════════════════════════════════
ARCHIVOS — base
══════════════════════════════════════════════ */

#[derive(Deserialize)]
struct DirQuery {
    dir: Option<String>,
    path: Option<String>,
}

async fn list_files(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Query(q): Query<DirQuery>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    if tokio::fs::metadata(&root).await.is_err() {
        let _ = tokio::fs::create_dir_all(&root).await;
    }

    let rel = q.dir.or(q.path).unwrap_or_default();
    let dir = match resolve_safe(&root, &rel).await {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    if !dir.is_dir() {
        return Ok(json_fail("No se puede acceder a la carpeta"));
    }

    let mut items = Vec::new();
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(_) => return Ok(json_fail("No se puede acceder a la carpeta")),
    };

    while let Ok(Some(ent)) = rd.next_entry().await {
        let name = ent.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let meta = ent.metadata().await.ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = meta.and_then(|m| m.modified().ok());
        let type_str = if is_dir {
            "dir"
        } else if name.ends_with(".jar") {
            "jar"
        } else if name.ends_with(".log") {
            "log"
        } else {
            "file"
        };
        let size_str = if is_dir {
            "-".to_string()
        } else {
            format!("{:.2} MB", size as f64 / 1024.0 / 1024.0)
        };
        let date = mtime
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| crate::format_datetime_secs(d.as_secs() as i64))
            .unwrap_or_default();

        items.push(json!({
            "name": name,
            "type": type_str,
            "size": size_str,
            "date": date,
        }));
    }

    items.sort_by(|a, b| {
        let ta = a.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let tb = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match (ta == "dir", tb == "dir") {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_lowercase()
                .cmp(
                    &b.get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_lowercase(),
                ),
        }
    });

    Ok(json_ok(json!({ "items": items })))
}

#[derive(Deserialize)]
struct PathQuery {
    path: Option<String>,
}

/// Tamaño máximo para abrir un archivo como texto en el panel (JSON en memoria).
const MAX_TEXT_EDIT_BYTES: u64 = 5 * 1024 * 1024;

async fn get_file_content(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Result<Response, StatusCode> {
    use tokio::io::AsyncReadExt;

    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let rel = q.path.unwrap_or_default();
    let path = match resolve_safe(&root, &rel).await {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    if !path.is_file() {
        return Ok(json_fail("No se puede leer el archivo"));
    }

    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) => m,
        Err(_) => return Ok(json_fail("No se puede leer el archivo")),
    };
    if meta.len() > MAX_TEXT_EDIT_BYTES {
        return Ok(json_fail(
            "El archivo es demasiado grande para editarlo como texto (máx. 5 MB). Usa la descarga.",
        ));
    }

    // Lectura acotada: no usamos read_to_string sobre ficheros arbitrarios.
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return Ok(json_fail("No se puede leer el archivo")),
    };
    let mut buf = Vec::with_capacity(meta.len() as usize);
    if file.read_to_end(&mut buf).await.is_err() {
        return Ok(json_fail("No se puede leer el archivo"));
    }
    let content = match String::from_utf8(buf) {
        Ok(s) => s,
        Err(_) => {
            return Ok(json_fail(
                "El archivo no es texto UTF-8 válido. Usa la descarga para archivos binarios.",
            ));
        }
    };

    Ok(json_ok(json!({
        "content": content,
        "filename": path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
    })))
}

#[derive(Deserialize)]
struct PutBody {
    path: String,
    content: serde_json::Value,
}

async fn put_file_content(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<PutBody>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let path = match resolve_safe(&root, &body.path).await {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let text = match body.content {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    };
    match tokio::fs::write(&path, text.as_bytes()).await {
        Ok(()) => Ok(json_ok(json!({}))),
        Err(_) => Ok(json_fail("No se puede guardar")),
    }
}

async fn download_file(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let rel = q.path.unwrap_or_default();
    let path = match resolve_safe(&root, &rel).await {
        Ok(p) => p,
        Err(_) => return Err(StatusCode::FORBIDDEN),
    };
    if !path.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }

    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file.bin".into());

    let stream = file_byte_stream(file);

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/octet-stream")
        .header(
            "content-disposition",
            format!("attachment; filename=\"{name}\""),
        );
    if meta.len() > 0 {
        builder = builder.header("content-length", meta.len());
    }
    builder
        .body(axum::body::Body::from_stream(stream))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(Deserialize)]
struct DeleteBody {
    items: Option<Vec<String>>,
    path: Option<String>,
}

async fn delete_files(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<DeleteBody>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let paths: Vec<String> = body
        .items
        .unwrap_or_default()
        .into_iter()
        .chain(body.path)
        .collect();

    let mut deleted = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for rel in paths {
        let path = match resolve_safe(&root, &rel).await {
            Ok(p) => p,
            Err(e) => {
                errors.push(format!("{rel}: {e}"));
                continue;
            }
        };
        let result = if path.is_dir() {
            tokio::fs::remove_dir_all(&path).await
        } else {
            tokio::fs::remove_file(&path).await
        };
        match result {
            Ok(()) => deleted += 1,
            Err(e) => errors.push(format!("{rel}: {e}")),
        }
    }

    if !errors.is_empty() {
        let detail = errors.join("; ");
        return Ok(json_fail(&format!(
            "No se pudieron eliminar {n} elemento(s): {detail}",
            n = errors.len()
        )));
    }
    Ok(json_ok(json!({ "deleted": deleted })))
}

#[derive(Deserialize)]
struct CreateBody {
    path: String,
    #[serde(default)]
    is_dir: bool,
    #[serde(rename = "type")]
    kind: Option<String>,
}

async fn create_file(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<CreateBody>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let path = match resolve_safe(&root, &body.path).await {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    let is_dir = body.is_dir || body.kind.as_deref() == Some("dir");
    let result = if is_dir {
        tokio::fs::create_dir_all(&path).await
    } else {
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        tokio::fs::write(&path, b"").await
    };
    match result {
        Ok(()) => Ok(json_ok(json!({}))),
        Err(_) => Ok(json_fail("No se pudo crear")),
    }
}

/* ══════════════════════════════════════════════
ARCHIVOS — Fase 1
══════════════════════════════════════════════ */

#[derive(Deserialize)]
struct UploadQuery {
    #[serde(rename = "uploadId")]
    upload_id: String,
    path: String,
    offset: u64,
    #[serde(rename = "totalSize")]
    total_size: u64,
    #[serde(default, rename = "final")]
    final_flag: String,
    #[serde(default)]
    overwrite: String,
}

async fn load_manifest(upload_dir: &Path, upload_id: &str) -> Option<UploadManifest> {
    let bytes = tokio::fs::read(upload_dir.join(format!("{}.json", upload_id)))
        .await
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

async fn save_manifest(
    upload_dir: &Path,
    upload_id: &str,
    manifest: &UploadManifest,
) -> std::io::Result<()> {
    let json = serde_json::to_vec(manifest).map_err(std::io::Error::other)?;
    tokio::fs::write(upload_dir.join(format!("{}.json", upload_id)), json).await
}

async fn upload_chunk(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    if q.upload_id.len() < 8
        || q.upload_id.len() > 120
        || !q
            .upload_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Ok(json_fail("Identificador de subida no válido"));
    }
    if q.path.trim().is_empty() {
        return Ok(json_fail("Ruta requerida"));
    }
    if body.len() > UPLOAD_MAX_CHUNK {
        return Ok(json_fail("Bloque demasiado grande"));
    }
    let validated_chunk_end = match q.offset.checked_add(body.len() as u64) {
        Some(end) if end <= q.total_size => end,
        _ => return Ok(json_fail("El bloque excede el tamaño indicado")),
    };

    let full = match resolve_safe(&root, &q.path).await {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };

    let is_final = q.final_flag == "1";
    let overwrite = q.overwrite == "1";

    if !overwrite && full.exists() {
        return Ok(Json(json!({
            "ok": false,
            "status": 409,
            "isFileConflict": true,
            "error": "Ya existe un archivo con ese nombre",
        }))
        .into_response());
    }

    let upload_lock = {
        let mut map = st.uploads.lock().await;
        map.entry(q.upload_id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(UploadManifest::default())))
            .clone()
    };
    let mut manifest = upload_lock.lock().await;

    if manifest.path.is_empty() {
        manifest.path = q.path.clone();
        manifest.total_size = q.total_size;
        if let Some(prev) = load_manifest(&root.join(UPLOAD_DIR_NAME), &q.upload_id).await
            && prev.path == q.path
            && prev.total_size == q.total_size
        {
            *manifest = prev;
        }
    } else if manifest.path != q.path || manifest.total_size != q.total_size {
        return Ok(json_fail("La subida no coincide con sus datos originales"));
    }

    let upload_dir = root.join(UPLOAD_DIR_NAME);
    if let Err(e) = tokio::fs::create_dir_all(&upload_dir).await {
        return Ok(json_fail(&format!(
            "No se pudo crear carpeta temporal: {e}"
        )));
    }

    let part_path = upload_dir.join(format!("{}.part", q.upload_id));

    if !body.is_empty() {
        use tokio::io::{AsyncSeekExt, AsyncWriteExt};

        let mut file = match tokio::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&part_path)
            .await
        {
            Ok(f) => f,
            Err(e) => return Ok(json_fail(&format!("No se pudo abrir part: {e}"))),
        };
        if let Err(e) = file.seek(std::io::SeekFrom::Start(q.offset)).await {
            return Ok(json_fail(&format!("Seek falló: {e}")));
        }
        if let Err(e) = file.write_all(&body).await {
            return Ok(json_fail(&format!("Write falló: {e}")));
        }

        let chunk_end = validated_chunk_end;
        let duplicate = manifest
            .chunks
            .iter()
            .any(|c| c.offset == q.offset && c.end == chunk_end);
        if !duplicate {
            manifest.chunks.push(ChunkRange {
                offset: q.offset,
                end: chunk_end,
            });
            manifest.chunks.sort_by_key(|c| c.offset);
        }
    }

    let mut merged: Vec<ChunkRange> = Vec::new();
    for c in manifest.chunks.drain(..) {
        if let Some(last) = merged.last_mut()
            && c.offset <= last.end
        {
            last.end = last.end.max(c.end);
            continue;
        }
        merged.push(c);
    }
    manifest.chunks = merged;

    if let Ok(f) = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&part_path)
        .await
    {
        let _ = f.set_len(q.total_size).await;
    }

    let complete = if q.total_size == 0 {
        let _ = tokio::fs::write(&part_path, b"").await;
        true
    } else {
        manifest.chunks.len() == 1
            && manifest.chunks[0].offset == 0
            && manifest.chunks[0].end == q.total_size
    };

    if let Err(e) = save_manifest(&upload_dir, &q.upload_id, &manifest).await {
        tracing::warn!("No se pudo guardar manifest: {e}");
    }

    if !complete || !is_final {
        let uploaded: u64 = manifest.chunks.iter().map(|c| c.end - c.offset).sum();
        return Ok(json_ok(json!({
            "uploaded": uploaded,
            "complete": false,
        })));
    }

    let final_size = tokio::fs::metadata(&part_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if final_size != q.total_size {
        return Ok(json_fail(&format!(
            "Tamaño final incorrecto: {}/{}",
            final_size, q.total_size
        )));
    }

    if let Some(parent) = full.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    if overwrite && full.exists() {
        let _ = tokio::fs::remove_file(&full).await;
    }

    if let Err(e) = tokio::fs::rename(&part_path, &full).await {
        return Ok(json_fail(&format!("No se pudo mover archivo final: {e}")));
    }
    let _ = tokio::fs::remove_file(upload_dir.join(format!("{}.json", q.upload_id))).await;

    {
        let mut map = st.uploads.lock().await;
        map.remove(&q.upload_id);
    }

    Ok(json_ok(json!({
        "uploaded": final_size,
        "complete": true,
        "path": q.path,
    })))
}

#[derive(Deserialize)]
struct RenameBody {
    path: String,
    #[serde(rename = "newName")]
    new_name: String,
}

async fn rename_file(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<RenameBody>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    if body.new_name.contains('/') || body.new_name.contains('\\') || body.new_name.contains("..") {
        return Ok(json_fail("Nombre no válido"));
    }

    let from = match resolve_safe(&root, &body.path).await {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    let parent_rel = match Path::new(&body.path).parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_string_lossy().replace('\\', "/"),
        _ => String::new(),
    };
    let target_rel = if parent_rel.is_empty() {
        body.new_name.clone()
    } else {
        format!("{}/{}", parent_rel, body.new_name)
    };
    let to = match resolve_safe(&root, &target_rel).await {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };

    match tokio::fs::rename(&from, &to).await {
        Ok(()) => Ok(json_ok(json!({}))),
        Err(e) => Ok(json_fail(&format!("No se pudo renombrar: {e}"))),
    }
}

#[derive(Deserialize)]
struct TransferBody {
    path: String,
    dest: String,
}

async fn copy_file(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<TransferBody>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let src = match resolve_safe(&root, &body.path).await {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    let dst = match resolve_safe(&root, &body.dest).await {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    if let Some(parent) = dst.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    let src_clone = src.clone();
    let dst_clone = dst.clone();
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        if src_clone.is_dir() {
            for entry in WalkDir::new(&src_clone).into_iter().filter_map(|e| e.ok()) {
                let rel = match entry.path().strip_prefix(&src_clone) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let target = dst_clone.join(rel);
                if entry.file_type().is_dir() {
                    std::fs::create_dir_all(&target)?;
                } else if entry.file_type().is_file() {
                    if let Some(p) = target.parent() {
                        std::fs::create_dir_all(p)?;
                    }
                    std::fs::copy(entry.path(), &target)?;
                }
            }
            Ok(())
        } else {
            if let Some(p) = dst_clone.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::copy(&src_clone, &dst_clone)?;
            Ok(())
        }
    })
    .await;

    match result {
        Ok(Ok(())) => Ok(json_ok(json!({}))),
        Ok(Err(e)) => Ok(json_fail(&format!("No se pudo copiar: {e}"))),
        Err(e) => Ok(json_fail(&format!("Tarea copia falló: {e}"))),
    }
}

async fn move_file(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<TransferBody>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let src = match resolve_safe(&root, &body.path).await {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    let dst = match resolve_safe(&root, &body.dest).await {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    if let Some(parent) = dst.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    match tokio::fs::rename(&src, &dst).await {
        Ok(()) => Ok(json_ok(json!({}))),
        Err(e) => Ok(json_fail(&format!("No se pudo mover: {e}"))),
    }
}

#[derive(Deserialize)]
struct CompressBody {
    path: String,
    name: String,
}

async fn compress_file(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<CompressBody>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let src = match resolve_safe(&root, &body.path).await {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    if !src.exists() {
        return Ok(json_fail("Archivo o carpeta no encontrada"));
    }

    let safe_name: String = body
        .name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let zip_name = format!("{}.zip", safe_name);
    let zip_path = src.parent().unwrap_or(&root).join(&zip_name);

    let src_clone = src.clone();
    let zip_clone = zip_path.clone();
    let name_clone = safe_name.clone();

    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let file = std::fs::File::create(&zip_clone)?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(6));

        if src_clone.is_dir() {
            for entry in WalkDir::new(&src_clone).into_iter().filter_map(|e| e.ok()) {
                if entry.path() == src_clone {
                    continue;
                }
                let rel = entry.path().strip_prefix(&src_clone)?;
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                let name = format!("{}/{}", name_clone, rel_str);
                if entry.file_type().is_dir() {
                    zip.add_directory(&name, options)?;
                } else if entry.file_type().is_file() {
                    zip.start_file(&name, options)?;
                    let mut f = std::fs::File::open(entry.path())?;
                    std::io::copy(&mut f, &mut zip)?;
                }
            }
        } else {
            zip.start_file(&name_clone, options)?;
            let mut f = std::fs::File::open(&src_clone)?;
            std::io::copy(&mut f, &mut zip)?;
        }

        zip.finish()?;
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => Ok(json_ok(json!({ "zipName": zip_name }))),
        Ok(Err(e)) => Ok(json_fail(&format!("Error creando ZIP: {e}"))),
        Err(e) => Ok(json_fail(&format!("Tarea ZIP falló: {e}"))),
    }
}

#[derive(Deserialize)]
struct BulkItem {
    path: String,
}

#[derive(Deserialize)]
struct BulkBody {
    action: String,
    items: Vec<BulkItem>,
    #[serde(default)]
    destination: String,
}

async fn bulk_action(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<BulkBody>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    if !["delete", "move", "compress"].contains(&body.action.as_str()) {
        return Ok(json_fail("Operación masiva no válida"));
    }
    if body.items.is_empty() || body.items.len() > 500 {
        return Ok(json_fail("Número de elementos no válido"));
    }

    let mut completed = 0usize;
    let mut failed = 0usize;
    let mut results = Vec::new();

    for item in &body.items {
        let result: anyhow::Result<()> = async {
            let full = resolve_safe(&root, &item.path)
                .await
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            if !full.exists() {
                anyhow::bail!("No existe");
            }

            match body.action.as_str() {
                "delete" => {
                    if full.is_dir() {
                        tokio::fs::remove_dir_all(&full).await?;
                    } else {
                        tokio::fs::remove_file(&full).await?;
                    }
                }
                "move" => {
                    let name = full
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let target_rel = if body.destination.trim().is_empty() {
                        name
                    } else {
                        format!("{}/{}", body.destination.trim_end_matches('/'), name)
                    };
                    let dst = resolve_safe(&root, &target_rel)
                        .await
                        .map_err(|e| anyhow::anyhow!("{}", e))?;
                    if let Some(p) = dst.parent() {
                        let _ = tokio::fs::create_dir_all(p).await;
                    }
                    tokio::fs::rename(&full, &dst).await?;
                }
                "compress" => {
                    let name = full
                        .file_stem()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "archivo".into());
                    let safe_name: String = name
                        .chars()
                        .map(|c| {
                            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                                c
                            } else {
                                '_'
                            }
                        })
                        .collect();
                    let zip_path = full
                        .parent()
                        .unwrap_or(&root)
                        .join(format!("{}.zip", safe_name));
                    let src = full.clone();
                    let dst = zip_path.clone();
                    let base = safe_name.clone();
                    let is_dir = src.is_dir();
                    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                        let file = std::fs::File::create(&dst)?;
                        let mut zip = ZipWriter::new(file);
                        let options = SimpleFileOptions::default()
                            .compression_method(zip::CompressionMethod::Deflated)
                            .compression_level(Some(6));
                        if is_dir {
                            for entry in WalkDir::new(&src).into_iter().filter_map(|e| e.ok()) {
                                if entry.path() == src {
                                    continue;
                                }
                                let rel = entry.path().strip_prefix(&src)?;
                                let rel_str = rel.to_string_lossy().replace('\\', "/");
                                let name = format!("{}/{}", base, rel_str);
                                if entry.file_type().is_dir() {
                                    zip.add_directory(&name, options)?;
                                } else if entry.file_type().is_file() {
                                    zip.start_file(&name, options)?;
                                    let mut f = std::fs::File::open(entry.path())?;
                                    std::io::copy(&mut f, &mut zip)?;
                                }
                            }
                        } else {
                            zip.start_file(&base, options)?;
                            let mut f = std::fs::File::open(&src)?;
                            std::io::copy(&mut f, &mut zip)?;
                        }
                        zip.finish()?;
                        Ok(())
                    })
                    .await??;
                }
                _ => unreachable!(),
            }
            Ok(())
        }
        .await;

        match result {
            Ok(()) => {
                completed += 1;
                results.push(json!({ "path": item.path, "ok": true }));
            }
            Err(e) => {
                failed += 1;
                results.push(json!({ "path": item.path, "ok": false, "error": e.to_string() }));
            }
        }
    }

    Ok(json_ok(json!({
        "completed": completed,
        "failed": failed,
        "results": results,
    })))
}

/* ══════════════════════════════════════════════
BACKUPS
══════════════════════════════════════════════ */

fn backups_dir(root: &Path) -> PathBuf {
    root.join(BACKUPS_REL_DIR)
}

fn backup_excluded(name: &str) -> bool {
    BACKUP_EXCLUDES.iter().any(|e| e.eq_ignore_ascii_case(name))
}

fn backup_first_component_excluded(rel: &Path) -> bool {
    match rel.components().next() {
        Some(std::path::Component::Normal(name)) => {
            let name = name.to_string_lossy();
            backup_excluded(name.as_ref())
        }
        _ => false,
    }
}

/// Una sola pasada síncrona: lista de archivos a incluir y tamaño total.
/// Pensada para ejecutarse dentro de `spawn_blocking`.
fn collect_backup_files(root: &Path) -> (Vec<(std::path::PathBuf, u64)>, u64) {
    let mut files: Vec<(std::path::PathBuf, u64)> = Vec::new();
    let mut total = 0u64;
    let walker = WalkDir::new(root).into_iter().filter_entry(|entry| {
        // No descender en carpetas excluidas (backups, libraries, etc.).
        if entry.depth() == 0 {
            return true;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            return false;
        };
        !backup_first_component_excluded(rel)
    });
    for entry in walker.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path == root || !entry.file_type().is_file() {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let size = meta.len();
        total = total.saturating_add(size);
        files.push((path.to_path_buf(), size));
    }
    (files, total)
}

async fn get_backup_progress(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    drop(s);
    let p = st.backup_progress.lock().await.clone();
    Ok(json_ok(json!({ "progress": p })))
}

async fn list_backups(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let dir = backups_dir(&root);
    let _ = tokio::fs::create_dir_all(&dir).await;

    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(_) => return Ok(json_ok(json!({ "backups": [] }))),
    };

    let mut backups = Vec::new();
    while let Ok(Some(ent)) = rd.next_entry().await {
        let name = ent.file_name().to_string_lossy().to_string();
        if !name.to_lowercase().ends_with(".zip") {
            continue;
        }
        let meta = match ent.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let date = crate::format_datetime_secs(mtime);
        backups.push(json!({
            "name": name,
            "sizeMb": format!("{:.2}", meta.len() as f64 / 1024.0 / 1024.0),
            "createdAt": mtime * 1000,
            "date": date,
        }));
    }

    backups.sort_by(|a, b| {
        let ca = a.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let cb = b.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
        cb.cmp(&ca)
    });

    Ok(json_ok(json!({ "backups": backups })))
}

async fn create_backup(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    {
        let mut op = st.backup_operation.lock().await;
        if op.is_some() {
            return Ok(json_fail("Ya hay una operación de copias en curso"));
        }
        *op = Some("creación".into());
    }

    let label = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let result = async {
        let dir = backups_dir(&root);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| anyhow::anyhow!("No se pudo crear carpeta de backups: {e}"))?;

        {
            let mut p = st.backup_progress.lock().await;
            p.active = true;
            p.phase = "flush".into();
            p.processed_bytes = 0;
            // total_bytes se fija en la pasada del zip (evita WalkDir doble)
            p.total_bytes = 0;
            p.percent = 0;
            p.started_at = Some(crate::now_ms());
            p.error = None;
        }

        let server_running = st.mc.read().await.is_some();
        if server_running {
            let mut mc = st.mc.write().await;
            if let Some(child) = mc.as_mut()
                && let Some(stdin) = child.stdin.as_mut()
            {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(b"save-off\r\n").await;
                let _ = stdin.write_all(b"save-all flush\r\n").await;
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let timestamp = crate::format_file_stamp();
        let safe_label = if label.is_empty() {
            "backup".to_string()
        } else {
            label
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || "._ -".contains(c) {
                        c
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
                .replace(' ', "_")
        };
        let zip_name = format!("{}_{}.zip", safe_label, timestamp);
        let zip_path = dir.join(&zip_name);

        {
            let mut p = st.backup_progress.lock().await;
            p.phase = "zipping".into();
        }

        let root_clone = root.clone();
        let zip_path_clone = zip_path.clone();
        let progress_ref = Arc::clone(&st.backup_progress);

        let create_result = tokio::task::spawn_blocking(move || -> anyhow::Result<u64> {
            // Una pasada: listar archivos + tamaños; luego zip sin segundo WalkDir ni re-stat.
            let (files, total) = collect_backup_files(&root_clone);
            if let Ok(mut guard) = progress_ref.try_lock() {
                guard.total_bytes = total;
            }

            let file = std::fs::File::create(&zip_path_clone)?;
            let mut zip = ZipWriter::new(std::io::BufWriter::with_capacity(256 * 1024, file));
            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .compression_level(Some(6));

            let mut dirs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
            for (path, _) in &files {
                if let Ok(rel) = path.strip_prefix(&root_clone) {
                    let mut acc = std::path::PathBuf::new();
                    let comps: Vec<_> = rel.components().collect();
                    for comp in comps.iter().take(comps.len().saturating_sub(1)) {
                        acc.push(comp);
                        dirs.insert(acc.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
            for dir in &dirs {
                zip.add_directory(dir, options)?;
            }

            let mut processed = 0u64;
            let mut last_reported = 0u64;
            const PROGRESS_STEP: u64 = 512 * 1024;

            for (path, size) in &files {
                let Ok(rel) = path.strip_prefix(&root_clone) else {
                    continue;
                };
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                zip.start_file(&rel_str, options)?;
                let f = std::fs::File::open(path)?;
                let mut reader = std::io::BufReader::with_capacity(256 * 1024, f);
                std::io::copy(&mut reader, &mut zip)?;
                processed = processed.saturating_add(*size);

                if processed.saturating_sub(last_reported) >= PROGRESS_STEP || processed == total {
                    last_reported = processed;
                    if let Ok(mut guard) = progress_ref.try_lock() {
                        guard.processed_bytes = processed;
                        guard.total_bytes = total;
                        if total > 0 {
                            guard.percent = (processed.saturating_mul(100) / total).min(99) as u32;
                        }
                    }
                }
            }
            zip.finish()?;
            Ok(processed)
        })
        .await;

        if server_running {
            let mut mc = st.mc.write().await;
            if let Some(child) = mc.as_mut()
                && let Some(stdin) = child.stdin.as_mut()
            {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(b"save-on\r\n").await;
            }
        }

        create_result
            .map_err(|e| anyhow::anyhow!("Tarea ZIP falló: {e}"))?
            .map_err(|e| anyhow::anyhow!("Error creando ZIP: {e}"))?;

        if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
            let mut files = Vec::new();
            while let Ok(Some(ent)) = rd.next_entry().await {
                let name = ent.file_name().to_string_lossy().to_string();
                if !name.to_lowercase().ends_with(".zip") {
                    continue;
                }
                if let Ok(meta) = ent.metadata().await
                    && let Ok(modified) = meta.modified()
                {
                    files.push((name, modified));
                }
            }
            files.sort_by_key(|a| std::cmp::Reverse(a.1));
            for (name, _) in files.into_iter().skip(BACKUP_RETENTION) {
                let _ = tokio::fs::remove_file(dir.join(&name)).await;
            }
        }

        let meta = tokio::fs::metadata(&zip_path)
            .await
            .map_err(|e| anyhow::anyhow!("No se pudo leer el ZIP: {e}"))?;

        {
            let mut p = st.backup_progress.lock().await;
            p.active = false;
            p.phase = "done".into();
            p.percent = 100;
        }

        Ok::<(String, f64), anyhow::Error>((zip_name, meta.len() as f64 / 1024.0 / 1024.0))
    }
    .await;

    {
        let mut op = st.backup_operation.lock().await;
        *op = None;
    }

    match result {
        Ok((name, size_mb)) => Ok(json_ok(json!({
            "name": name,
            "sizeMb": format!("{:.2}", size_mb),
        }))),
        Err(e) => {
            let mut p = st.backup_progress.lock().await;
            p.active = false;
            p.phase = "error".into();
            p.error = Some(e.to_string());
            Ok(json_fail(&format!("No se pudo crear la copia: {e}")))
        }
    }
}

async fn download_backup(
    State(st): State<LocalState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(StatusCode::FORBIDDEN);
    }
    if !name.to_lowercase().ends_with(".zip") {
        return Err(StatusCode::FORBIDDEN);
    }

    let path = backups_dir(&root).join(&name);
    if !path.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }

    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let stream = file_byte_stream(file);

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/zip")
        .header(
            "content-disposition",
            format!("attachment; filename=\"{name}\""),
        );
    if meta.len() > 0 {
        builder = builder.header("content-length", meta.len());
    }
    builder
        .body(axum::body::Body::from_stream(stream))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn delete_backup(
    State(st): State<LocalState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Ok(json_fail("Nombre no válido"));
    }
    if !name.to_lowercase().ends_with(".zip") {
        return Ok(json_fail("Nombre no válido"));
    }

    {
        let mut op = st.backup_operation.lock().await;
        if op.is_some() {
            return Ok(json_fail("Ya hay una operación de copias en curso"));
        }
        *op = Some("eliminación".into());
    }

    let path = backups_dir(&root).join(&name);
    let result = tokio::fs::remove_file(&path).await;

    {
        let mut op = st.backup_operation.lock().await;
        *op = None;
    }

    match result {
        Ok(()) => Ok(json_ok(json!({}))),
        Err(e) => Ok(json_fail(&format!("No se pudo eliminar: {e}"))),
    }
}

async fn restore_backup(
    State(st): State<LocalState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Ok(json_fail("Nombre no válido"));
    }
    if !name.to_lowercase().ends_with(".zip") {
        return Ok(json_fail("Nombre no válido"));
    }

    let zip_path = backups_dir(&root).join(&name);
    if !zip_path.is_file() {
        return Ok(json_fail("Copia de seguridad no encontrada"));
    }

    {
        let mut op = st.backup_operation.lock().await;
        if op.is_some() {
            return Ok(json_fail("Ya hay una operación de copias en curso"));
        }
        *op = Some("restauración".into());
    }

    let _lifecycle = st.lifecycle.lock().await;
    st.intentional_stop.store(true, Ordering::Release);
    let was_running = st.mc.read().await.is_some();
    if was_running && let Err(error) = stop_server_process_inner(&st).await {
        let mut op = st.backup_operation.lock().await;
        *op = None;
        drop(op);

        let mut state = st.app.write().await;
        state.add_console_log(
            "error",
            format!("No se pudo restaurar la copia porque Minecraft no terminó: {error}"),
        );
        return Ok(json_fail(&format!(
            "No se pudo iniciar la restauración porque Minecraft seguía ejecutándose: {error}"
        )));
    }

    let root_clone = root.clone();
    let zip_path_clone = zip_path.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let file = std::fs::File::open(&zip_path_clone)?;
        let mut archive = zip::ZipArchive::new(file)?;

        // 1. Extraer y validar en una carpeta temporal dentro de .moonwolf
        let ts = crate::now_secs();
        let mut rnd_bytes = [0u8; 4];
        rand::rng().fill_bytes(&mut rnd_bytes);
        let rnd = u32::from_be_bytes(rnd_bytes);
        let staging_dir = backups_dir(&root_clone).join(format!(".restore-stage-{ts}-{rnd}"));
        let rollback_dir = backups_dir(&root_clone).join(format!(".restore-rollback-{ts}-{rnd}"));

        if staging_dir.exists() {
            let _ = std::fs::remove_dir_all(&staging_dir);
        }
        std::fs::create_dir_all(&staging_dir)?;

        let extract_result = (|| -> anyhow::Result<()> {
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i)?;
                let rel = entry
                    .enclosed_name()
                    .ok_or_else(|| anyhow::anyhow!("Entrada inválida en ZIP"))?
                    .to_path_buf();

                let first = rel
                    .components()
                    .next()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .unwrap_or_default();
                if backup_excluded(&first) {
                    continue;
                }

                let target = staging_dir.join(&rel);
                if entry.is_dir() {
                    std::fs::create_dir_all(&target)?;
                } else {
                    if let Some(parent) = target.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    let mut out = std::fs::File::create(&target)?;
                    std::io::copy(&mut entry, &mut out)?;
                }
            }
            Ok(())
        })();

        if let Err(e) = extract_result {
            let _ = std::fs::remove_dir_all(&staging_dir);
            anyhow::bail!("Error al extraer y validar copia en staging temporal: {e}");
        }

        // Helper para copiar directorio recursivamente
        fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
            std::fs::create_dir_all(dst)?;
            for entry in std::fs::read_dir(src)? {
                let entry = entry?;
                let file_type = entry.file_type()?;
                let dest_path = dst.join(entry.file_name());
                if file_type.is_dir() {
                    copy_dir_all(&entry.path(), &dest_path)?;
                } else {
                    std::fs::copy(entry.path(), &dest_path)?;
                }
            }
            Ok(())
        }

        // Helper para limpiar servidor. Los errores deben abortar la restauración.
        fn clear_server_files(root: &Path) -> std::io::Result<()> {
            for entry in std::fs::read_dir(root)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().to_string();
                if backup_excluded(&name) {
                    continue;
                }
                let p = entry.path();
                if entry.file_type()?.is_dir() {
                    std::fs::remove_dir_all(&p)?;
                } else {
                    std::fs::remove_file(&p)?;
                }
            }
            Ok(())
        }

        // 2. Crear copia de rollback del servidor actual
        if rollback_dir.exists() {
            let _ = std::fs::remove_dir_all(&rollback_dir);
        }
        std::fs::create_dir_all(&rollback_dir)?;

        let backup_created = (|| -> std::io::Result<()> {
            for entry in std::fs::read_dir(&root_clone)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().to_string();
                if backup_excluded(&name) {
                    continue;
                }
                let src_p = entry.path();
                let dst_p = rollback_dir.join(&name);
                if entry.file_type()?.is_dir() {
                    copy_dir_all(&src_p, &dst_p)?;
                } else {
                    std::fs::copy(&src_p, &dst_p)?;
                }
            }
            Ok(())
        })();

        if let Err(e) = backup_created {
            let _ = std::fs::remove_dir_all(&staging_dir);
            let _ = std::fs::remove_dir_all(&rollback_dir);
            anyhow::bail!("No se pudo crear copia de rollback previa: {e}");
        }

        // 3. Sustituir el servidor aplicando staging
        let replace_result = (|| -> anyhow::Result<()> {
            clear_server_files(&root_clone)?;

            for entry in std::fs::read_dir(&staging_dir)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().to_string();
                if backup_excluded(&name) {
                    continue;
                }
                let src_p = entry.path();
                let dst_p = root_clone.join(&name);
                if entry.file_type()?.is_dir() {
                    copy_dir_all(&src_p, &dst_p)?;
                } else {
                    std::fs::copy(&src_p, &dst_p)?;
                }
            }
            Ok(())
        })();

        if let Err(e) = replace_result {
            // Rollback si falla la sustitución. No declarar éxito si tampoco
            // se consigue recuperar íntegramente el contenido anterior.
            let rollback_result = (|| -> std::io::Result<()> {
                clear_server_files(&root_clone)?;
                for entry in std::fs::read_dir(&rollback_dir)? {
                    let entry = entry?;
                    let name = entry.file_name().to_string_lossy().to_string();
                    let src_p = entry.path();
                    let dst_p = root_clone.join(&name);
                    if entry.file_type()?.is_dir() {
                        copy_dir_all(&src_p, &dst_p)?;
                    } else {
                        std::fs::copy(&src_p, &dst_p)?;
                    }
                }
                Ok(())
            })();
            let _ = std::fs::remove_dir_all(&staging_dir);
            match rollback_result {
                Ok(()) => {
                    let _ = std::fs::remove_dir_all(&rollback_dir);
                    anyhow::bail!(
                        "Sustitución fallida; se recuperó el contenido anterior mediante rollback ({e})"
                    )
                },
                Err(rollback_error) => anyhow::bail!(
                    "Sustitución fallida ({e}) y el rollback también falló ({rollback_error}). La copia de rescate se conserva en {}",
                    rollback_dir.display()
                ),
            }
        }

        // Éxito: limpiar staging y rollback
        let _ = std::fs::remove_dir_all(&staging_dir);
        let _ = std::fs::remove_dir_all(&rollback_dir);
        Ok(())
    })
    .await;

    {
        let mut op = st.backup_operation.lock().await;
        *op = None;
    }

    match result {
        Ok(Ok(())) => {
            {
                let mut s = st.app.write().await;
                s.add_console_log("info", format!("Copia restaurada: {}", name));
            }

            let mut restarted = false;
            if was_running {
                let java_configured = st.app.read().await.config.java_path.clone();
                match start_server_inner(st.clone(), root.clone(), java_configured).await {
                    Ok(_) if st.mc.read().await.is_some() => {
                        restarted = true;
                    }
                    Ok(_) => {
                        let mut s = st.app.write().await;
                        s.add_console_log(
                            "error",
                            "La copia se restauró, pero Minecraft no pudo volver a arrancar.",
                        );
                    }
                    Err(error) => {
                        let mut s = st.app.write().await;
                        s.add_console_log(
                            "error",
                            format!(
                                "La copia se restauró, pero falló el reinicio de Minecraft: {error}"
                            ),
                        );
                    }
                }
            }

            Ok(json_ok(
                json!({ "restored": true, "wasRunning": restarted, "restartFailed": was_running && !restarted }),
            ))
        }
        Ok(Err(e)) => {
            let message = e.to_string();
            if was_running && !message.contains("rollback también falló") {
                let java_configured = st.app.read().await.config.java_path.clone();
                let restart = start_server_inner(st.clone(), root.clone(), java_configured).await;
                if restart.is_err() || st.mc.read().await.is_none() {
                    let mut s = st.app.write().await;
                    s.add_console_log(
                        "error",
                        "La restauración falló y tampoco se pudo volver a iniciar Minecraft.",
                    );
                }
            }
            Ok(json_fail(&format!("No se pudo restaurar: {e}")))
        }
        Err(e) => {
            // spawn_blocking falló (JoinError): el servidor pudo haberse parado
            // antes de la restauración; intentar rearrancar igual que en Ok(Err).
            if was_running {
                let java_configured = st.app.read().await.config.java_path.clone();
                let restart = start_server_inner(st.clone(), root.clone(), java_configured).await;
                if restart.is_err() || st.mc.read().await.is_none() {
                    let mut s = st.app.write().await;
                    s.add_console_log(
                        "error",
                        "La restauración falló (tarea interna) y tampoco se pudo volver a iniciar Minecraft.",
                    );
                }
            }
            Ok(json_fail(&format!("Tarea restauración falló: {e}")))
        }
    }
}

/* ══════════════════════════════════════════════
STARTUP
══════════════════════════════════════════════ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupConfig {
    #[serde(default = "default_jar")]
    jar: String,
    #[serde(default = "default_java_mode")]
    java_mode: String,
    #[serde(default)]
    java_override_path: String,
    #[serde(default)]
    minecraft_version: String,
    #[serde(default = "default_min_mem")]
    min_memory_mb: u32,
    #[serde(default = "default_max_mem")]
    max_memory_mb: u32,
    #[serde(default)]
    extra_args: String,
    #[serde(default = "default_stop_cmd")]
    stop_command: String,
    #[serde(default)]
    auto_restart_on_crash: bool,
    #[serde(default)]
    auto_start_on_boot: bool,
}

fn default_jar() -> String {
    "server.jar".into()
}
fn default_java_mode() -> String {
    "managed".into()
}
fn default_min_mem() -> u32 {
    1024
}
fn default_max_mem() -> u32 {
    2048
}
fn default_stop_cmd() -> String {
    "stop".into()
}

impl Default for StartupConfig {
    fn default() -> Self {
        Self {
            jar: default_jar(),
            java_mode: default_java_mode(),
            java_override_path: String::new(),
            minecraft_version: String::new(),
            min_memory_mb: default_min_mem(),
            max_memory_mb: default_max_mem(),
            extra_args: String::new(),
            stop_command: default_stop_cmd(),
            auto_restart_on_crash: false,
            auto_start_on_boot: false,
        }
    }
}

fn startup_config_path(root: &Path) -> PathBuf {
    root.join(".moonwolf").join("startup.json")
}

fn load_startup_config_sync(root: &Path) -> StartupConfig {
    let path = startup_config_path(root);
    if let Ok(raw) = std::fs::read_to_string(&path)
        && let Ok(cfg) = serde_json::from_str::<StartupConfig>(&raw)
    {
        return cfg;
    }
    StartupConfig::default()
}

fn save_startup_config_sync(root: &Path, cfg: &StartupConfig) -> std::io::Result<()> {
    let path = startup_config_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(std::io::Error::other)?;
    std::fs::write(&path, json)
}

async fn load_startup_config(root: &Path) -> StartupConfig {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || load_startup_config_sync(&root))
        .await
        .unwrap_or_default()
}

async fn save_startup_config(root: &Path, cfg: &StartupConfig) -> std::io::Result<()> {
    let root = root.to_path_buf();
    let cfg = cfg.clone();
    tokio::task::spawn_blocking(move || save_startup_config_sync(&root, &cfg))
        .await
        .map_err(|e| std::io::Error::other(format!("tarea de configuración falló: {e}")))?
}

async fn list_jars(root: &Path) -> Vec<String> {
    let mut jars = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(root).await {
        while let Ok(Some(ent)) = rd.next_entry().await {
            let name = ent.file_name().to_string_lossy().to_string();
            if name.to_lowercase().ends_with(".jar") {
                jars.push(name);
            }
        }
    }
    jars.sort();
    jars
}

async fn get_startup(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let mut cfg = load_startup_config(&root).await;
    let jars = list_jars(&root).await;

    let props = read_properties(&root.join("server.properties")).await;
    let server_port: Option<u16> = props.get("server-port").and_then(|v| v.parse::<u16>().ok());

    // Si no hay versión guardada, intentar detectar automáticamente.
    let mut version_detection = json!(null);
    if cfg.minecraft_version.trim().is_empty() {
        let jar = if cfg.jar.is_empty() {
            jars.first().cloned().unwrap_or_default()
        } else {
            cfg.jar.clone()
        };
        if let Some((ver, source)) = detect_minecraft_version(&root, &jar).await {
            cfg.minecraft_version = ver.clone();
            let _ = save_startup_config(&root, &cfg).await;
            version_detection = json!({
                "version": ver,
                "source": source,
                "persisted": true,
                "autoDetected": true,
            });
        }
    }

    Ok(json_ok(json!({
        "config": cfg,
        "jars": jars,
        "serverPort": server_port,
        "versionDetection": version_detection,
    })))
}

#[derive(Deserialize)]
struct StartupSaveBody {
    jar: Option<String>,
    #[serde(rename = "javaMode")]
    java_mode: Option<String>,
    #[serde(rename = "javaOverridePath")]
    java_override_path: Option<String>,
    #[serde(rename = "minecraftVersion")]
    minecraft_version: Option<String>,
    #[serde(rename = "minMemoryMb")]
    min_memory_mb: Option<u32>,
    #[serde(rename = "maxMemoryMb")]
    max_memory_mb: Option<u32>,
    #[serde(rename = "extraArgs")]
    extra_args: Option<String>,
    #[serde(rename = "stopCommand")]
    stop_command: Option<String>,
    #[serde(rename = "autoRestartOnCrash")]
    auto_restart_on_crash: Option<bool>,
    #[serde(rename = "autoStartOnBoot")]
    auto_start_on_boot: Option<bool>,
    #[serde(rename = "serverPort")]
    server_port: Option<u16>,
}
async fn save_startup(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<StartupSaveBody>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let jar = match body.jar {
        Some(j) if !j.is_empty() => j,
        _ => return Ok(json_fail("Selecciona un archivo .jar")),
    };

    if jar.contains('/') || jar.contains('\\') || jar.contains("..") {
        return Ok(json_fail("Nombre de .jar no válido"));
    }

    if !root.join(&jar).exists() {
        return Ok(json_fail(&format!(
            "El archivo {} no existe en la carpeta del servidor",
            jar
        )));
    }

    let mut cfg = load_startup_config(&root).await;
    cfg.jar = jar;
    if let Some(v) = body.java_mode {
        cfg.java_mode = v;
    }
    if let Some(v) = body.java_override_path {
        cfg.java_override_path = v;
    }
    if let Some(v) = body.minecraft_version {
        cfg.minecraft_version = v;
    }
    if let Some(v) = body.min_memory_mb {
        cfg.min_memory_mb = v;
    }
    if let Some(v) = body.max_memory_mb {
        cfg.max_memory_mb = v;
    }
    if cfg.min_memory_mb > 0 && cfg.max_memory_mb > 0 && cfg.min_memory_mb > cfg.max_memory_mb {
        return Ok(json_fail(
            "La memoria mínima no puede ser mayor que la máxima",
        ));
    }
    if cfg.java_mode.eq_ignore_ascii_case("override") {
        let override_path = cfg.java_override_path.trim();
        if override_path.is_empty() {
            return Ok(json_fail(
                "Java personalizado activado: indica la ruta al ejecutable de Java",
            ));
        }
        if let Err(msg) = resolve_override_java_binary(override_path) {
            return Ok(json_fail(&msg));
        }
    }
    if let Some(v) = body.extra_args {
        cfg.extra_args = v;
    }
    if let Some(v) = body.stop_command
        && !v.is_empty()
    {
        cfg.stop_command = v;
    }
    if let Some(v) = body.auto_restart_on_crash {
        cfg.auto_restart_on_crash = v;
    }
    if let Some(v) = body.auto_start_on_boot {
        cfg.auto_start_on_boot = v;
    }

    if let Err(e) = save_startup_config(&root, &cfg).await {
        return Ok(json_fail(&format!("No se pudo guardar startup: {e}")));
    }

    if let Some(port) = body.server_port {
        let props_path = root.join("server.properties");
        let mut props = read_properties(&props_path).await;
        props.insert("server-port".into(), port.to_string());
        if let Err(e) = write_properties(&props_path, &props).await {
            return Ok(json_fail(&format!(
                "Startup guardado, pero falló server.properties: {e}"
            )));
        }
    }

    Ok(json_ok(json!({ "config": cfg })))
}

#[derive(Deserialize)]
struct DetectVersionBody {
    jar: Option<String>,
    #[serde(default)]
    force: bool,
    #[serde(default)]
    persist: Option<bool>,
}

async fn detect_version(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<DetectVersionBody>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let cfg = load_startup_config(&root).await;
    let jar = body
        .jar
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cfg.jar.clone());

    if jar.contains('/') || jar.contains('\\') || jar.contains("..") {
        return Ok(json_fail("Nombre de .jar no válido"));
    }

    let (version_str, source) = match detect_minecraft_version(&root, &jar).await {
        Some((v, s)) => (v, s),
        None => (String::new(), "none".to_string()),
    };
    let mut persisted = false;

    if !version_str.is_empty()
        && body.persist.unwrap_or(true)
        && (body.force || cfg.minecraft_version.is_empty())
    {
        let mut cfg2 = load_startup_config(&root).await;
        cfg2.minecraft_version = version_str.clone();
        if save_startup_config(&root, &cfg2).await.is_ok() {
            persisted = true;
        }
    }

    Ok(json_ok(json!({
        "version": version_str,
        "source": source,
        "persisted": persisted,
    })))
}

/// Detecta la versión de Minecraft del servidor por varias fuentes.
async fn detect_minecraft_version(root: &Path, jar_name: &str) -> Option<(String, String)> {
    if let Some(v) = detect_version_from_name(jar_name) {
        return Some((v, "jar-name".into()));
    }
    // El JAR elegido es la fuente más fiable; los archivos del directorio
    // pueden pertenecer a una instalación anterior o a otro software.
    if let Some(v) = detect_version_from_jar_manifest(root, jar_name).await {
        return Some((v, "jar-manifest".into()));
    }
    if let Some(v) = detect_version_from_server_layout(root).await {
        return Some((v, "server-layout".into()));
    }
    if let Some(v) = detect_version_from_version_history(root).await {
        return Some((v, "version_history".into()));
    }
    if let Some(v) = detect_version_from_version_json(root).await {
        return Some((v, "version.json".into()));
    }
    if let Some(v) = detect_version_from_logs(root).await {
        return Some((v, "logs".into()));
    }
    None
}

fn detect_version_from_name(jar_name: &str) -> Option<String> {
    let lower = jar_name.to_lowercase();
    let parts: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .filter(|s| !s.is_empty())
        .collect();

    for part in parts {
        if let Some(v) = normalize_mc_version_candidate(part) {
            return Some(v);
        }
    }
    None
}

fn normalize_mc_version_candidate(part: &str) -> Option<String> {
    let part = part.trim().trim_start_matches('v');
    if part.is_empty() || !part.contains('.') {
        return None;
    }
    // Classic: 1.7 – 1.21.x
    if part.starts_with("1.") {
        let segments: Vec<&str> = part.split('.').collect();
        if segments.len() >= 2
            && let Ok(minor) = segments[1].parse::<u32>()
            && (7..=40).contains(&minor)
        {
            return Some(part.to_string());
        }
    }
    // Paper/Mojang modern: 26.1, 26.3, etc.
    if let Some(first) = part.split('.').next()
        && let Ok(major) = first.parse::<u32>()
        && (20..=40).contains(&major)
    {
        // Avoid pure build numbers like "142" by requiring dotted form already.
        return Some(part.to_string());
    }
    None
}

async fn detect_version_from_version_history(root: &Path) -> Option<String> {
    let path = root.join("version_history.json");
    let text = tokio::fs::read_to_string(path).await.ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    for key in ["currentVersion", "current_version", "version"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            if let Some(n) = normalize_mc_version_candidate(s) {
                return Some(n);
            }
            // Sometimes value is like "git-Paper-1.21.1-..."
            if let Some(n) = detect_version_from_name(s) {
                return Some(n);
            }
        }
    }
    None
}

async fn detect_version_from_version_json(root: &Path) -> Option<String> {
    for name in ["version.json", "minecraft_version.json"] {
        let path = root.join(name);
        let text = match tokio::fs::read_to_string(&path).await {
            Ok(t) => t,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for key in [
            "id",
            "name",
            "version",
            "minecraftVersion",
            "minecraft_version",
        ] {
            if let Some(s) = v.get(key).and_then(|x| x.as_str())
                && let Some(n) =
                    normalize_mc_version_candidate(s).or_else(|| detect_version_from_name(s))
            {
                return Some(n);
            }
        }
    }
    None
}

async fn detect_version_from_server_layout(root: &Path) -> Option<String> {
    // Fabric suele usar fabric-server-launch.jar como lanzador y deja el JAR
    // real en libraries/net/minecraft/server/<versión>/, por lo que el
    // lanzador no siempre contiene version.json ni la versión en su nombre.
    for rel in [
        "fabric-server-launcher.properties",
        "fabric-server-launcher.properties.txt",
    ] {
        if let Ok(text) = tokio::fs::read_to_string(root.join(rel)).await
            && let Some(version) = detect_version_from_name(&text)
        {
            return Some(version);
        }
    }

    for rel in [
        "libraries/net/minecraft/server",
        "libraries/net/minecraft/client",
    ] {
        let mut entries = match tokio::fs::read_dir(root.join(rel)).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(version) = normalize_mc_version_candidate(&name) {
                return Some(version);
            }
            if let Some(version) = detect_version_from_name(&name) {
                return Some(version);
            }
        }
    }

    None
}

async fn detect_version_from_jar_manifest(root: &Path, jar_name: &str) -> Option<String> {
    if jar_name.is_empty() {
        return None;
    }
    let path = root.join(jar_name);
    let data = tokio::fs::read(&path).await.ok()?;
    detect_version_from_jar_bytes(&data)
}

fn detect_version_from_jar_bytes(data: &[u8]) -> Option<String> {
    let cursor = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;

    // Los JARs modernos de Mojang suelen ser bundles: el servidor real aparece
    // como META-INF/versions/<versión>/server-<versión>.jar. Aunque no se
    // encuentre version.json en la raíz, el nombre de esa entrada ya es fiable.
    for index in 0..archive.len() {
        let Ok(file) = archive.by_index(index) else {
            continue;
        };
        let Ok(name) = file.name().map(|name| name.into_owned()) else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if lower.contains("/versions/") && detect_version_from_name(&name).is_some() {
            return detect_version_from_name(&name);
        }
    }

    // Leer metadatos aunque estén en una carpeta, con mayúsculas distintas o
    // bajo un nombre alternativo usado por loaders/mods.
    for index in 0..archive.len() {
        let Ok(mut file) = archive.by_index(index) else {
            continue;
        };
        let Ok(name) = file.name().map(|name| name.into_owned()) else {
            continue;
        };
        if !is_version_metadata_entry(&name) || file.size() > 2 * 1024 * 1024 {
            continue;
        }
        let mut text = String::new();
        if file.read_to_string(&mut text).is_err() {
            continue;
        }
        if let Some(version) = detect_version_from_metadata_text(&name, &text) {
            return Some(version);
        }
    }

    None
}

fn is_version_metadata_entry(name: &str) -> bool {
    let lower = name.replace('\\', "/").to_ascii_lowercase();
    let file_name = lower.rsplit('/').next().unwrap_or(lower.as_str());
    matches!(
        file_name,
        "version.json"
            | "minecraft_version.json"
            | "patch.properties"
            | "versions.list"
            | "manifest.mf"
            | "mods.toml"
            | "fabric.mod.json"
            | "quilt.mod.json"
            | "paper-plugin.yml"
            | "plugin.yml"
    ) || file_name.ends_with("version.properties")
}

fn detect_version_from_metadata_text(name: &str, text: &str) -> Option<String> {
    if name.to_ascii_lowercase().ends_with(".json")
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(text)
    {
        for key in [
            "id",
            "name",
            "version",
            "minecraftVersion",
            "minecraft_version",
            "mcVersion",
            "gameVersion",
        ] {
            if let Some(candidate) = value.get(key).and_then(|v| v.as_str())
                && let Some(version) = normalize_mc_version_candidate(candidate)
                    .or_else(|| detect_version_from_name(candidate))
            {
                return Some(version);
            }
        }
    }

    // Manifest/properties y los rangos de dependencias de los loaders suelen
    // contener la versión como parte de una línea, por ejemplo:
    // Minecraft-Version: 1.21.4 o minecraft = ">=1.20.1".
    for line in text.lines() {
        let line = line.trim();
        for prefix in [
            "Implementation-Version:",
            "Specification-Version:",
            "Minecraft-Version:",
            "Minecraft-Version=",
            "version=",
            "version:",
        ] {
            if line
                .get(..prefix.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
            {
                let rest = line[prefix.len()..].trim();
                if let Some(version) =
                    normalize_mc_version_candidate(rest).or_else(|| detect_version_from_name(rest))
                {
                    return Some(version);
                }
            }
        }
        if let Some(version) = detect_version_from_name(line) {
            return Some(version);
        }
    }

    None
}

#[cfg(test)]
mod version_detection_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn detects_bundled_server_version_from_entry_name() {
        let mut data = std::io::Cursor::new(Vec::new());
        {
            let mut archive = ZipWriter::new(&mut data);
            archive
                .start_file(
                    "META-INF/versions/1.21.4/server-1.21.4.jar",
                    SimpleFileOptions::default(),
                )
                .unwrap();
            archive.write_all(b"nested jar").unwrap();
            archive.finish().unwrap();
        }

        assert_eq!(
            detect_version_from_jar_bytes(data.get_ref()),
            Some("1.21.4".to_string())
        );
    }

    #[test]
    fn detects_version_from_loader_metadata() {
        assert_eq!(
            detect_version_from_metadata_text(
                "META-INF/mods.toml",
                "version=\"${file.jarVersion}\"\nversionRange=\"[1.20.1,1.21)\""
            ),
            Some("1.20.1".to_string())
        );
    }
}

async fn detect_version_from_logs(root: &Path) -> Option<String> {
    for rel in ["logs/latest.log", "logs/latest.log.gz"] {
        let path = root.join(rel);
        let text = if rel.ends_with(".gz") {
            // skip gzip for simplicity
            continue;
        } else {
            match tokio::fs::read_to_string(&path).await {
                Ok(t) => t,
                Err(_) => continue,
            }
        };
        // Scan last 200 lines first (more relevant), then full file head
        let lines: Vec<&str> = text.lines().collect();
        let tail = lines.iter().rev().take(250);
        let head = lines.iter().take(80);
        for line in tail.chain(head) {
            // "Loading Minecraft 1.21.1" / "for Minecraft 26.3"
            if let Some(idx) = line.find("Minecraft ") {
                let rest = &line[idx + "Minecraft ".len()..];
                let token = rest
                    .split(|c: char| c.is_whitespace() || c == ',' || c == ')')
                    .next()
                    .unwrap_or("");
                if let Some(n) = normalize_mc_version_candidate(token)
                    .or_else(|| detect_version_from_name(token))
                {
                    return Some(n);
                }
            }
            // "Starting minecraft server version 1.20.4"
            if let Some(idx) = line.to_lowercase().find("server version ") {
                let rest = &line[idx + "server version ".len()..];
                let token = rest.split_whitespace().next().unwrap_or("");
                if let Some(n) = normalize_mc_version_candidate(token)
                    .or_else(|| detect_version_from_name(token))
                {
                    return Some(n);
                }
            }
        }
    }
    None
}

/* ══════════════════════════════════════════════
PORTS
══════════════════════════════════════════════ */

async fn read_properties(path: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Ok(raw) = tokio::fs::read_to_string(path).await {
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(eq) = line.find('=') {
                let key = line[..eq].trim().to_string();
                let value = line[eq + 1..].trim().to_string();
                out.insert(key, value);
            }
        }
    }
    out
}

async fn write_properties(path: &Path, values: &HashMap<String, String>) -> std::io::Result<()> {
    let existing = tokio::fs::read_to_string(path).await.unwrap_or_default();

    let mut lines: Vec<String> = Vec::new();
    let mut updated = std::collections::HashSet::new();

    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            lines.push(line.to_string());
            continue;
        }
        if let Some(eq) = line.find('=') {
            let key = line[..eq].trim().to_string();
            if let Some(val) = values.get(&key) {
                lines.push(format!("{}={}", key, val));
                updated.insert(key);
                continue;
            }
        }
        lines.push(line.to_string());
    }

    for (key, val) in values {
        if !updated.contains(key) {
            lines.push(format!("{}={}", key, val));
        }
    }

    tokio::fs::write(path, lines.join("\n") + "\n").await
}

async fn get_ports(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let props = read_properties(&root.join("server.properties")).await;

    let server_port: u16 = props
        .get("server-port")
        .and_then(|v| v.parse().ok())
        .unwrap_or(25565);
    let query_enabled = props
        .get("enable-query")
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let query_port: u16 = props
        .get("query.port")
        .and_then(|v| v.parse().ok())
        .unwrap_or(25565);
    let rcon_enabled = props
        .get("enable-rcon")
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let rcon_port: u16 = props
        .get("rcon.port")
        .and_then(|v| v.parse().ok())
        .unwrap_or(25575);
    let has_rcon_password = props
        .get("rcon.password")
        .map(|v| !v.is_empty())
        .unwrap_or(false);

    let ports = vec![
        json!({
            "id": "minecraft", "name": "Minecraft",
            "description": "Puerto principal del servidor.",
            "protocol": "TCP", "port": server_port, "state": "configured",
        }),
        json!({
            "id": "query", "name": "Query",
            "description": if query_enabled { "Game Query habilitado." } else { "Game Query deshabilitado." },
            "protocol": "UDP", "port": query_port,
            "state": if query_enabled { "configured" } else { "disabled" },
        }),
        json!({
            "id": "rcon", "name": "RCON",
            "description": if rcon_enabled { "Consola remota habilitada." } else { "RCON deshabilitado." },
            "protocol": "TCP", "port": rcon_port,
            "state": if rcon_enabled { "configured" } else { "disabled" },
        }),
    ];

    Ok(json_ok(json!({
        "ports": ports,
        "properties": {
            "enableQuery": query_enabled,
            "enableRcon": rcon_enabled,
            "serverPort": server_port,
            "queryPort": query_port,
            "rconPort": rcon_port,
            "hasRconPassword": has_rcon_password,
        },
    })))
}

#[derive(Deserialize)]
struct SavePortsBody {
    #[serde(rename = "serverPort")]
    server_port: Option<u16>,
    #[serde(rename = "queryPort")]
    query_port: Option<u16>,
    #[serde(rename = "rconPort")]
    rcon_port: Option<u16>,
    #[serde(rename = "enableQuery")]
    enable_query: Option<bool>,
    #[serde(rename = "enableRcon")]
    enable_rcon: Option<bool>,
    #[serde(rename = "rconPassword")]
    rcon_password: Option<String>,
}

async fn save_ports(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<SavePortsBody>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let server_port = match body.server_port {
        Some(p) if p >= 1 => p,
        _ => return Ok(json_fail("Puerto de Minecraft no válido")),
    };
    let query_port = body.query_port.unwrap_or(server_port);
    let rcon_port = body.rcon_port.unwrap_or(25575);
    let enable_query = body.enable_query.unwrap_or(false);
    let enable_rcon = body.enable_rcon.unwrap_or(false);

    let props_path = root.join("server.properties");
    let mut props = read_properties(&props_path).await;

    props.insert("server-port".into(), server_port.to_string());
    props.insert("query.port".into(), query_port.to_string());
    props.insert("enable-query".into(), enable_query.to_string());
    props.insert("rcon.port".into(), rcon_port.to_string());
    props.insert("enable-rcon".into(), enable_rcon.to_string());

    if let Some(pw) = body.rcon_password
        && !pw.is_empty()
    {
        props.insert("rcon.password".into(), pw);
    }

    if enable_rcon
        && !props
            .get("rcon.password")
            .map(|p| !p.is_empty())
            .unwrap_or(false)
    {
        return Ok(json_fail("Debes indicar contraseña para activar RCON"));
    }

    if let Err(e) = write_properties(&props_path, &props).await {
        return Ok(json_fail(&format!(
            "No se pudo escribir server.properties: {e}"
        )));
    }

    Ok(json_ok(json!({
        "serverPort": server_port,
        "queryPort": query_port,
        "rconPort": rcon_port,
        "enableQuery": enable_query,
        "enableRcon": enable_rcon,
        "restartRequired": true,
    })))
}

/* ══════════════════════════════════════════════
SERVIDOR
══════════════════════════════════════════════ */

async fn server_status(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    {
        let s = st.app.read().await;
        check_auth(&headers, &s.config.local_token)?;
    }
    // "online" | "offline" | "unknown"
    // unknown = hay Child pero try_wait falló: no lo descartamos (kill_on_drop).
    let (status, running) = {
        let mut mc = st.mc.write().await;
        if let Some(child) = mc.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *mc = None;
                    ("offline", false)
                }
                Ok(None) => ("online", true),
                Err(_) => ("unknown", true),
            }
        } else {
            ("offline", false)
        }
    };
    {
        let mut s = st.app.write().await;
        // Conservar mc_running=true en unknown para no tratarlo como apagado.
        s.mc_running = running;
        if !running {
            s.mc_ready = false;
            s.mc_pid = None;
            s.mc_started_at_ms = None;
        }
    }
    Ok(json_ok(json!({
        "status": status,
        "running": running,
        "unknown": status == "unknown",
    })))
}

async fn find_server_jar(root: &Path, preferred: &str) -> Option<PathBuf> {
    if !preferred.is_empty() {
        let p = root.join(preferred);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(mut rd) = tokio::fs::read_dir(root).await {
        let mut jars = Vec::new();
        while let Ok(Some(ent)) = rd.next_entry().await {
            let name = ent.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if lower.ends_with(".jar") && !lower.contains("installer") {
                jars.push(ent.path());
            }
        }
        jars.sort();
        return jars.into_iter().next();
    }
    None
}

fn java_runtimes_dir() -> PathBuf {
    crate::AgentConfig::config_dir().join("runtimes")
}

fn find_best_java_runtime() -> Option<(u32, PathBuf)> {
    let dir = java_runtimes_dir();
    let entries = std::fs::read_dir(&dir).ok()?;
    let mut best: Option<(u32, PathBuf)> = None;
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let major = match name
            .strip_prefix("java")
            .and_then(|s| s.parse::<u32>().ok())
        {
            Some(v) => v,
            None => continue,
        };
        let java_exe = if cfg!(windows) {
            entry.path().join("bin").join("java.exe")
        } else {
            entry.path().join("bin").join("java")
        };
        if !java_exe.is_file() {
            continue;
        }
        match best {
            Some((best_major, _)) if best_major >= major => {}
            _ => best = Some((major, java_exe)),
        }
    }
    best
}

/// Valida una ruta de Java en modo override: debe existir y ser un archivo.
/// No hace fallback a runtimes gestionados ni al PATH.
fn resolve_override_java_binary(override_path: &str) -> Result<PathBuf, String> {
    let configured = override_path.trim();
    if configured.is_empty() {
        return Err("Java personalizado activado, pero no hay ruta configurada".into());
    }
    let p = PathBuf::from(configured);
    if p.is_file() {
        return Ok(p);
    }
    // En Windows, permitir indicar la ruta sin la extensión .exe.
    #[cfg(windows)]
    {
        if !configured.to_ascii_lowercase().ends_with(".exe") {
            let with_exe = PathBuf::from(format!("{configured}.exe"));
            if with_exe.is_file() {
                return Ok(with_exe);
            }
        }
    }
    Err(format!(
        "La ruta de Java personalizado no es un ejecutable válido: {configured}"
    ))
}

fn resolve_java_binary(config_java_path: &str) -> (PathBuf, String) {
    let configured = config_java_path.trim();
    if !configured.is_empty() && configured != "java" {
        let p = PathBuf::from(configured);
        if p.is_absolute() && p.is_file() {
            return (p, "ruta configurada".to_string());
        }
    }
    if let Some((major, path)) = find_best_java_runtime() {
        return (path, format!("runtimes/java{}", major));
    }
    (PathBuf::from("java"), "PATH del sistema".to_string())
}

fn is_minecraft_ready_line(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    (message.contains("done (") && message.contains("for help, type"))
        || message.contains("listening on /")
        || message.contains("listening on 0.0.0.0")
        || message.contains("listening on [::]")
}

fn is_metric_reply_line(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("there are ") && lower.contains("players online")
        || lower.contains("tps from last")
        || lower.contains("average tick time")
        || lower.contains("target tick rate")
        || lower.contains("server tps")
        || lower.contains("mspt")
        || lower.contains("tick statistics")
        || lower.contains("tick rate")
}

fn is_metric_probe_command(cmd: &str) -> bool {
    matches!(
        cmd.trim().to_ascii_lowercase().as_str(),
        "list" | "tps" | "tick query"
    )
}

async fn read_console_stream<R>(stream: R, app: Arc<RwLock<AppState>>, level: &'static str)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut reader = BufReader::new(stream);
    let mut buffer = Vec::with_capacity(1024);

    loop {
        buffer.clear();

        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) => break,
            Ok(_) => {
                if buffer.last() == Some(&b'\n') {
                    buffer.pop();
                }
                if buffer.last() == Some(&b'\r') {
                    buffer.pop();
                }

                // Una salida con bytes que no sean UTF-8 no debe detener la lectura.
                let line = String::from_utf8_lossy(&buffer).into_owned();
                let became_ready = is_minecraft_ready_line(&line);
                let mut state = app.write().await;
                if became_ready {
                    state.mc_ready = true;
                }
                let probe_active = state.metric_probe_until_ms > crate::now_ms();
                let silent = probe_active && is_metric_reply_line(&line);
                state.add_console_log_ex(level, line, silent);
            }
            Err(error) => {
                let mut state = app.write().await;
                state.add_console_log(
                    "error",
                    format!("Error leyendo la salida de Java ({level}): {error}"),
                );
                break;
            }
        }
    }
}

async fn start_server(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    let java_configured = s.config.java_path.clone();
    drop(s);

    // Cubre preparación + spawn para que stop/restart no interfieran a mitad.
    let _lifecycle = st.lifecycle.lock().await;
    start_server_inner(st.clone(), root, java_configured).await
}

async fn start_server_inner(
    st: LocalState,
    root: PathBuf,
    java_configured: String,
) -> Result<Response, StatusCode> {
    if tokio::fs::metadata(&root).await.is_err() {
        let _ = tokio::fs::create_dir_all(&root).await;
    }

    let cfg = load_startup_config(&root).await;
    let jar = match find_server_jar(&root, &cfg.jar).await {
        Some(j) => j,
        None => {
            let mut s = st.app.write().await;
            s.add_console_log(
                "error",
                "No se encontró ningún .jar en la carpeta del servidor",
            );
            return Ok(json_fail(
                "No se encontró ningún .jar en la carpeta del servidor",
            ));
        }
    };

    // Ruta de Java:
    // - override: exige javaOverridePath válida (archivo ejecutable). Sin fallback silencioso.
    // - managed: AgentConfig / auto-detección vía resolve_java_binary.
    let (java_bin, java_source) = if cfg.java_mode.eq_ignore_ascii_case("override") {
        let override_path = cfg.java_override_path.trim().to_string();
        if override_path.is_empty() {
            let msg = "Java personalizado activado, pero no hay ruta configurada";
            let mut s = st.app.write().await;
            s.add_console_log("error", msg);
            return Ok(json_fail(msg));
        }
        let resolved =
            tokio::task::spawn_blocking(move || resolve_override_java_binary(&override_path))
                .await
                .map_err(|e| {
                    tracing::error!("Validación de Java personalizado falló: {e}");
                    StatusCode::INTERNAL_SERVER_ERROR
                })?;
        match resolved {
            Ok(path) => (path, "ruta personalizada (override)".to_string()),
            Err(msg) => {
                let mut s = st.app.write().await;
                s.add_console_log("error", &msg);
                return Ok(json_fail(&msg));
            }
        }
    } else {
        tokio::task::spawn_blocking(move || resolve_java_binary(&java_configured))
            .await
            .map_err(|e| {
                tracing::error!("Detección de Java falló: {e}");
                StatusCode::INTERNAL_SERVER_ERROR
            })?
    };
    {
        let mut s = st.app.write().await;
        s.add_console_log(
            "info",
            format!("Usando Java desde {} ({})", java_bin.display(), java_source),
        );
    }

    let min_mem = if cfg.min_memory_mb > 0 {
        cfg.min_memory_mb
    } else {
        1024
    };
    // Nunca permitir -Xms > -Xmx: si max < min, elevar max hasta min.
    let max_mem = {
        let m = if cfg.max_memory_mb > 0 {
            cfg.max_memory_mb
        } else {
            2048
        };
        m.max(min_mem)
    };

    let mut cmd = Command::new(&java_bin);
    cmd.current_dir(&root)
        .arg(format!("-Xms{}M", min_mem))
        .arg(format!("-Xmx{}M", max_mem));

    for token in cfg.extra_args.split_whitespace() {
        cmd.arg(token);
    }

    cmd.arg("-jar")
        .arg(&jar)
        .arg("nogui")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // Check + spawn + store under the same write lock so two concurrent
    // /api/start calls cannot both pass the "not running" check and launch Java.
    let (pid, stdout, stderr) = {
        let mut mc = st.mc.write().await;
        if let Some(existing) = mc.as_mut() {
            match existing.try_wait() {
                Ok(Some(_)) => {
                    *mc = None;
                }
                Ok(None) => {
                    return Ok(json_fail("El servidor ya está en ejecución"));
                }
                // Estado desconocido: no descartar el Child (kill_on_drop).
                Err(_) => {
                    return Ok(json_fail(
                        "El servidor ya está en ejecución (estado desconocido)",
                    ));
                }
            }
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let msg = format!(
                    "No se pudo arrancar Java desde {} ({}): {e}",
                    java_bin.display(),
                    java_source
                );
                drop(mc);
                let mut s = st.app.write().await;
                s.add_console_log("error", msg.clone());
                return Ok(json_fail(&msg));
            }
        };

        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        *mc = Some(child);
        st.intentional_stop.store(false, Ordering::Release);
        (pid, stdout, stderr)
    };

    {
        let mut s = st.app.write().await;
        s.mc_running = true;
        s.mc_ready = false;
        s.mc_pid = pid;
        s.mc_started_at_ms = Some(crate::now_ms());
        s.add_console_log(
            "info",
            format!("Servidor Minecraft arrancado ({})", jar.display()),
        );
    }

    if let Some(stdout) = stdout {
        let app = Arc::clone(&st.app);
        tokio::spawn(async move {
            read_console_stream(stdout, app, "info").await;
        });
    }

    if let Some(stderr) = stderr {
        let app = Arc::clone(&st.app);
        tokio::spawn(async move {
            read_console_stream(stderr, app, "error").await;
        });
    }

    {
        let watcher_state = st.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                let mut lock = watcher_state.mc.write().await;
                let Some(child) = lock.as_mut() else { break };
                match child.try_wait() {
                    Ok(Some(status)) => {
                        *lock = None;
                        drop(lock);

                        let (server_root, java_configured) = {
                            let mut state = watcher_state.app.write().await;
                            state.mc_running = false;
                            state.mc_ready = false;
                            state.mc_pid = None;
                            state.mc_started_at_ms = None;
                            state.add_console_log(
                                "warn",
                                format!("Servidor Minecraft terminó (código {:?})", status.code()),
                            );
                            (
                                state.config.server_dir.clone(),
                                state.config.java_path.clone(),
                            )
                        };

                        if !watcher_state.intentional_stop.load(Ordering::Acquire)
                            && load_startup_config(&server_root)
                                .await
                                .auto_restart_on_crash
                        {
                            let restart_state = watcher_state.clone();
                            tokio::spawn(async move {
                                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                if restart_state.intentional_stop.load(Ordering::Acquire) {
                                    return;
                                }

                                let _lifecycle = restart_state.lifecycle.lock().await;
                                if restart_state.intentional_stop.load(Ordering::Acquire)
                                    || restart_state.mc.read().await.is_some()
                                    || !load_startup_config(&server_root)
                                        .await
                                        .auto_restart_on_crash
                                {
                                    return;
                                }

                                {
                                    let mut state = restart_state.app.write().await;
                                    state.add_console_log(
                                        "warn",
                                        "Minecraft terminó inesperadamente. Intentando reiniciarlo automáticamente...",
                                    );
                                }

                                let result = start_server_restartable(
                                    restart_state.clone(),
                                    server_root,
                                    java_configured,
                                )
                                .await;

                                if result.is_err() || restart_state.mc.read().await.is_none() {
                                    let mut state = restart_state.app.write().await;
                                    state.add_console_log(
                                        "error",
                                        "No se pudo completar el reinicio automático de Minecraft.",
                                    );
                                }
                            });
                        }
                        break;
                    }
                    Ok(None) => drop(lock),
                    // Error temporal al consultar el estado: conservar el Child.
                    // Descartarlo con kill_on_drop(true) podría matar Java.
                    Err(error) => {
                        drop(lock);
                        let mut s = watcher_state.app.write().await;
                        s.add_console_log(
                            "warn",
                            format!(
                                "No se pudo comprobar el estado del servidor (se reintentará): {error}"
                            ),
                        );
                    }
                }
            }
        });
    }

    Ok(json_ok(json!({})))
}

/// Envuelve `start_server_inner` borrando el tipo concreto de su futuro
/// (`Pin<Box<dyn Future + Send>>`) para romper la dependencia circular de `Send`:
/// el watcher de procesos arrancado dentro de `start_server_inner` puede volver
/// a llamarla tras un crash, y `tokio::spawn` exige futuros `Send`.
fn start_server_restartable(
    st: LocalState,
    root: PathBuf,
    java_configured: String,
) -> Pin<Box<dyn Future<Output = Result<Response, StatusCode>> + Send>> {
    Box::pin(start_server_inner(st, root, java_configured))
}

// Tiempo máximo para que Minecraft guarde el mundo, cierre plugins y termine Java.
const SERVER_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const SERVER_SHUTDOWN_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopOutcome {
    NotRunning,
    Graceful,
    Forced,
}

/// Solicita un apagado normal y espera a que Java termine.
/// Solo fuerza la terminación cuando supera el límite de espera.
async fn stop_server_process(st: &LocalState) -> Result<StopOutcome, String> {
    st.intentional_stop.store(true, Ordering::Release);
    let _lifecycle = st.lifecycle.lock().await;
    stop_server_process_inner(st).await
}

async fn stop_server_process_inner(st: &LocalState) -> Result<StopOutcome, String> {
    st.intentional_stop.store(true, Ordering::Release);
    let root = st.app.read().await.config.server_dir.clone();
    let stop_cmd = load_startup_config(&root).await.stop_command;

    // Mantener el lock de mc durante el apagado evita que otra solicitud envíe
    // comandos o intente arrancar otro proceso mientras el anterior sigue vivo.
    let mut mc = st.mc.write().await;
    let Some(child) = mc.as_mut() else {
        return Ok(StopOutcome::NotRunning);
    };

    // El timeout total incluye el envío del comando stop (write + flush).
    let deadline = tokio::time::Instant::now() + SERVER_SHUTDOWN_TIMEOUT;
    const STOP_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    let mut command_error = None;
    if let Some(stdin) = child.stdin.as_mut() {
        use tokio::io::AsyncWriteExt;
        let write_result = tokio::time::timeout(STOP_COMMAND_TIMEOUT, async {
            stdin
                .write_all(format!("{stop_cmd}\r\n").as_bytes())
                .await?;
            stdin.flush().await?;
            Ok::<(), std::io::Error>(())
        })
        .await;

        match write_result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                command_error = Some(format!("No se pudo enviar el comando de apagado: {error}"));
            }
            Err(_) => {
                command_error =
                    Some("Timeout al enviar el comando de apagado a Java (5s)".to_owned());
            }
        }
    } else {
        command_error = Some("La entrada de consola de Java ya no está disponible.".to_owned());
    }
    let mut exited = false;

    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                exited = true;
                break;
            }
            Ok(None) => {}
            Err(error) => {
                command_error.get_or_insert_with(|| {
                    format!("No se pudo consultar el estado de Java: {error}")
                });
            }
        }

        if tokio::time::Instant::now() >= deadline {
            break;
        }

        tokio::time::sleep(SERVER_SHUTDOWN_POLL_INTERVAL).await;
    }

    let mut forced = false;
    if !exited {
        match child.kill().await {
            Ok(()) => {
                // tokio::process::Child::kill espera a que el proceso haya terminado.
                exited = true;
                forced = true;
            }
            Err(kill_error) => match child.try_wait() {
                Ok(Some(_status)) => {
                    exited = true;
                }
                Ok(None) => {
                    return Err(format!(
                        "No se pudo detener Java después de esperar {} segundos. El proceso sigue en ejecución: {kill_error}",
                        SERVER_SHUTDOWN_TIMEOUT.as_secs()
                    ));
                }
                Err(check_error) => {
                    return Err(format!(
                        "No se pudo confirmar que Java haya terminado. Error al forzar el cierre: {kill_error}; error al comprobar el proceso: {check_error}"
                    ));
                }
            },
        }
    }

    if !exited {
        return Err("No se pudo confirmar que el proceso Java haya terminado.".to_owned());
    }

    // Solo se elimina el handle cuando Java ya terminó. Soltamos el lock antes
    // de tocar el estado general para no bloquear las consultas de estado.
    *mc = None;
    drop(mc);

    {
        let mut s = st.app.write().await;
        s.mc_running = false;
        s.mc_ready = false;
        s.mc_pid = None;
        s.mc_started_at_ms = None;

        if forced {
            s.add_console_log(
                "error",
                format!(
                    "Minecraft no terminó en {} segundos y tuvo que cerrarse a la fuerza. Puede que algunos datos no se hayan guardado.",
                    SERVER_SHUTDOWN_TIMEOUT.as_secs()
                ),
            );
        } else if let Some(error) = command_error {
            s.add_console_log(
                "warn",
                format!(
                    "Minecraft terminó, pero hubo un problema al solicitar el apagado: {error}"
                ),
            );
            s.add_console_log("info", "Servidor detenido correctamente.");
        } else {
            s.add_console_log("info", "Servidor detenido correctamente.");
        }
    }

    Ok(if forced {
        StopOutcome::Forced
    } else {
        StopOutcome::Graceful
    })
}

async fn stop_server(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    drop(s);

    match stop_server_process(&st).await {
        Ok(StopOutcome::NotRunning) => Ok(json_fail("El servidor no está corriendo")),
        Ok(StopOutcome::Graceful) => Ok(json_ok(json!({"forced": false}))),
        Ok(StopOutcome::Forced) => Ok(json_ok(json!({"forced": true}))),
        Err(error) => {
            let mut s = st.app.write().await;
            s.add_console_log("error", format!("No se pudo completar el apagado: {error}"));
            Ok(json_fail(&error))
        }
    }
}

async fn restart_server(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    let java_configured = s.config.java_path.clone();
    drop(s);

    // Un solo hold de lifecycle para stop + start (sin ventana entre ambos).
    let _lifecycle = st.lifecycle.lock().await;

    // No arrancar un segundo Java si el anterior no ha terminado realmente.
    if let Err(error) = stop_server_process_inner(&st).await {
        let mut s = st.app.write().await;
        s.add_console_log(
            "error",
            format!("No se pudo reiniciar el servidor: {error}"),
        );
        return Ok(json_fail(&format!(
            "No se pudo reiniciar el servidor porque el proceso anterior no terminó: {error}"
        )));
    }

    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    start_server_inner(st.clone(), root, java_configured).await
}

#[derive(Deserialize)]
struct CmdBody {
    cmd: String,
    #[serde(default)]
    silent: bool,
}

async fn send_command(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<CmdBody>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    drop(s);

    let mut mc = st.mc.write().await;
    let Some(child) = mc.as_mut() else {
        return Ok(json_fail("El servidor no está corriendo"));
    };
    let cmd = body.cmd.trim();
    if cmd.is_empty() {
        return Ok(json_fail("Comando vacío"));
    }
    if cmd.len() > 4096 {
        return Ok(json_fail("El comando supera el límite de 4096 bytes"));
    }

    use tokio::io::AsyncWriteExt;
    let Some(stdin) = child.stdin.as_mut() else {
        return Ok(json_fail(
            "La consola del proceso Java no está disponible (entrada estándar cerrada)",
        ));
    };

    // En Windows muchos procesos Java esperan CRLF.
    let line = format!("{cmd}\r\n");
    if let Err(error) = stdin.write_all(line.as_bytes()).await {
        return Ok(json_fail(&format!(
            "No se pudo escribir en la consola del servidor: {error}"
        )));
    }
    if let Err(error) = stdin.flush().await {
        return Ok(json_fail(&format!(
            "No se pudo confirmar el envío del comando: {error}"
        )));
    }

    // Los comandos internos de métricas no deben ensuciar la consola visible.
    // Sus respuestas siguen entrando en el búfer (silent) para el recolector.
    {
        let mut s = st.app.write().await;
        if body.silent && is_metric_probe_command(cmd) {
            // Ventana corta: list/tps pueden devolver varias líneas.
            s.metric_probe_until_ms = crate::now_ms() + 2_500;
        }
        if !body.silent {
            s.add_console_log("info", format!("> {cmd}"));
        }
    }

    Ok(json_ok(json!({})))
}

/* ══════════════════════════════════════════════
VERSIONS
══════════════════════════════════════════════ */

async fn versions_software() -> Response {
    json_ok(json!({
        "software": [
            { "id": "paper", "label": "Paper", "category": "plugins", "desc": "Servidor de alto rendimiento compatible con plugins." },
            { "id": "purpur", "label": "Purpur", "category": "plugins", "desc": "Fork de Paper con configuración avanzada." },
            { "id": "folia", "label": "Folia", "category": "plugins", "desc": "Fork de Paper con multithreading regional." },
            { "id": "leaves", "label": "Leaves", "category": "plugins", "desc": "Fork de Paper orientado a optimización y configuración." },
            { "id": "leaf", "label": "Leaf", "category": "plugins", "desc": "Fork de Paper con optimizaciones adicionales." },
            { "id": "spigot", "label": "Spigot", "category": "plugins", "desc": "Servidor clásico compatible con plugins Bukkit." },
            { "id": "bukkit", "label": "CraftBukkit", "category": "plugins", "desc": "Implementación base de la API Bukkit." },
            { "id": "mohist", "label": "Mohist", "category": "hybrid", "desc": "Híbrido Forge + Bukkit para mods y plugins a la vez." },
            { "id": "arclight", "label": "Arclight", "category": "hybrid", "desc": "Híbrido Forge/NeoForge/Fabric + Bukkit." },
            { "id": "magma", "label": "Magma", "category": "hybrid", "desc": "Híbrido Forge + Bukkit orientado a rendimiento." },
            { "id": "spongevanilla", "label": "SpongeVanilla", "category": "plugins", "desc": "Servidor Sponge sobre Vanilla (API de plugins Sponge)." },
            { "id": "spongeforge", "label": "SpongeForge", "category": "hybrid", "desc": "Sponge sobre Forge (mods Forge + plugins Sponge)." },
            { "id": "spongeneo", "label": "SpongeNeo", "category": "hybrid", "desc": "Sponge sobre NeoForge." },
            { "id": "fabric", "label": "Fabric", "category": "mods", "desc": "Loader ligero para mods." },
            { "id": "quilt", "label": "Quilt", "category": "mods", "desc": "Fork de Fabric centrado en la comunidad y mods." },
            { "id": "forge", "label": "Forge", "category": "mods", "desc": "Loader clásico para mods." },
            { "id": "neoforge", "label": "NeoForge", "category": "mods", "desc": "Loader moderno para mods." },
            { "id": "velocity", "label": "Velocity", "category": "proxy", "desc": "Proxy moderno." },
            { "id": "waterfall", "label": "Waterfall", "category": "proxy", "desc": "Proxy basado en BungeeCord." },
            { "id": "bungeecord", "label": "BungeeCord", "category": "proxy", "desc": "Proxy clásico de md_5 para redes multi-servidor." },
            { "id": "vanilla", "label": "Vanilla", "category": "vanilla", "desc": "Servidor oficial de Mojang." }
        ]
    }))
}

#[derive(Deserialize)]
struct VersionsListQuery {
    software: Option<String>,
}

async fn versions_list(Query(q): Query<VersionsListQuery>) -> Response {
    let sw = q.software.unwrap_or_default();
    if sw.is_empty() {
        return json_fail("software requerido");
    }

    let res: Result<Vec<String>, String> = match sw.as_str() {
        "paper" | "folia" | "velocity" | "waterfall" => list_papermc_versions(&sw).await,
        "purpur" => list_purpur_versions().await,
        "leaves" => list_leaves_versions().await,
        "leaf" => list_mcjars_versions("Leaf").await,
        "spigot" | "bukkit" => list_spigot_hub_versions().await,
        "mohist" => list_mcjars_versions("Mohist").await,
        "arclight" => list_mcjars_versions("Arclight").await,
        "magma" => list_mcjars_versions("Magma").await,
        "spongevanilla" | "spongeforge" | "spongeneo" => list_sponge_versions(&sw).await,
        "fabric" => list_fabric_versions().await,
        "quilt" => list_quilt_versions().await,
        "vanilla" => list_vanilla_versions().await,
        "forge" => list_forge_versions().await,
        "neoforge" => list_neoforge_versions().await,
        "bungeecord" => list_bungeecord_versions().await,
        _ => Err(format!("Software no soportado: {sw}")),
    };

    match res {
        Ok(v) => json_ok(json!({ "versions": v })),
        Err(e) => json_fail(&e),
    }
}

async fn list_papermc_versions(sw: &str) -> Result<Vec<String>, String> {
    let url = format!("https://fill.papermc.io/v3/projects/{sw}");
    let v = fetch_json(&url).await?;
    let mut all: Vec<String> = Vec::new();
    if let Some(versions) = v.get("versions").and_then(|v| v.as_object()) {
        for group in versions.values() {
            if let Some(arr) = group.as_array() {
                for item in arr {
                    if let Some(s) = item.as_str() {
                        all.push(s.to_string());
                    }
                }
            }
        }
    }
    all.sort_by(|a, b| semver_cmp(b, a));
    Ok(all)
}

async fn list_purpur_versions() -> Result<Vec<String>, String> {
    let v = fetch_json("https://api.purpurmc.org/v2/purpur").await?;
    let arr = v
        .get("versions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<String> = arr
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    out.reverse();
    Ok(out)
}

async fn list_leaves_versions() -> Result<Vec<String>, String> {
    let v = fetch_json("https://api.leavesmc.org/v2/projects/leaves").await?;
    let arr = v
        .get("versions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<String> = arr
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    out.reverse();
    Ok(out)
}

async fn list_sponge_versions(sw: &str) -> Result<Vec<String>, String> {
    let artifact = match sw {
        "spongeforge" => "spongeforge",
        "spongeneo" => "spongeneo",
        _ => "spongevanilla",
    };
    let url = format!(
        "https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/{artifact}/versions"
    );
    let v = fetch_json(&url).await?;
    let arts = v
        .get("artifacts")
        .and_then(|a| a.as_object())
        .cloned()
        .unwrap_or_default();
    let mut set = std::collections::BTreeSet::new();
    for meta in arts.values() {
        if let Some(mc) = meta
            .pointer("/tagValues/minecraft")
            .and_then(|s| s.as_str())
        {
            set.insert(mc.to_string());
        }
    }
    let mut out: Vec<String> = set.into_iter().collect();
    out.sort_by(|a, b| semver_cmp(b, a));
    Ok(out)
}

async fn builds_sponge(sw: &str, version: &str) -> Result<Vec<serde_json::Value>, String> {
    let artifact = match sw {
        "spongeforge" => "spongeforge",
        "spongeneo" => "spongeneo",
        _ => "spongevanilla",
    };
    let url = format!(
        "https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/{artifact}/versions"
    );
    let v = fetch_json(&url).await?;
    let arts = v
        .get("artifacts")
        .and_then(|a| a.as_object())
        .cloned()
        .unwrap_or_default();

    let mut candidates: Vec<(String, bool)> = Vec::new();
    for (vid, meta) in &arts {
        let mc = meta
            .pointer("/tagValues/minecraft")
            .and_then(|s| s.as_str())
            .unwrap_or("");
        if mc != version {
            continue;
        }
        let recommended = meta
            .get("recommended")
            .and_then(|r| r.as_bool())
            .unwrap_or(false);
        candidates.push((vid.clone(), recommended));
    }
    // Prefer recommended, then newer-looking ids first (API order is usually newest first)
    candidates.sort_by_key(|a| std::cmp::Reverse(a.1));

    let mut out = Vec::new();
    for (vid, recommended) in candidates.into_iter().take(20) {
        let detail_url = format!(
            "https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/{artifact}/versions/{vid}"
        );
        let detail = match fetch_json(&detail_url).await {
            Ok(d) => d,
            Err(_) => continue,
        };
        let assets = detail
            .get("assets")
            .and_then(|a| a.as_array())
            .cloned()
            .unwrap_or_default();
        // Prefer universal jar, then the unclassified jar.
        let mut download = None;
        for a in &assets {
            let classifier = a.get("classifier").and_then(|c| c.as_str()).unwrap_or("");
            let ext = a.get("extension").and_then(|e| e.as_str()).unwrap_or("");
            if ext != "jar" {
                continue;
            }
            if classifier == "universal" {
                download = a
                    .get("downloadUrl")
                    .and_then(|u| u.as_str())
                    .map(|s| s.to_string());
                break;
            }
        }
        if download.is_none() {
            for a in &assets {
                let classifier = a.get("classifier").and_then(|c| c.as_str());
                let ext = a.get("extension").and_then(|e| e.as_str()).unwrap_or("");
                if ext == "jar" && classifier.is_none() {
                    download = a
                        .get("downloadUrl")
                        .and_then(|u| u.as_str())
                        .map(|s| s.to_string());
                    break;
                }
            }
        }
        let Some(url) = download else {
            continue;
        };
        let api = detail
            .pointer("/tags/api")
            .and_then(|s| s.as_str())
            .unwrap_or("");
        out.push(json!({
            "build": vid,
            "channel": if recommended { "RELEASE" } else { "PRERELEASE" },
            "time": null,
            "url": url,
            "sha256": null,
            "changes": format!("{artifact} {vid} · Minecraft {version} · API {api}"),
        }));
    }
    Ok(out)
}

async fn list_spigot_hub_versions() -> Result<Vec<String>, String> {
    // Prefer Spigot hub index; fallback to Mojang releases.
    let html = match fetch_text("https://hub.spigotmc.org/versions/").await {
        Ok(h) => h,
        Err(_) => {
            return list_vanilla_versions().await;
        }
    };
    let mut out = Vec::new();
    for part in html.split("href=\"") {
        let Some(end) = part.find(".json\"") else {
            continue;
        };
        let name = &part[..end];
        if name
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
            && !name.contains("pre")
            && !name.contains("rc")
        {
            out.push(name.to_string());
        }
    }
    if out.is_empty() {
        return list_vanilla_versions().await;
    }
    out.sort_by(|a, b| semver_cmp(b, a));
    Ok(out)
}

async fn list_mcjars_versions(project: &str) -> Result<Vec<String>, String> {
    let url = format!("https://mcjars.app/api/v2/builds/{project}");
    let v = fetch_json(&url).await?;
    let obj = v
        .get("builds")
        .and_then(|b| b.as_object())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<String> = obj.keys().cloned().collect();
    out.sort_by(|a, b| semver_cmp(b, a));
    Ok(out)
}

async fn list_bungeecord_versions() -> Result<Vec<String>, String> {
    // BungeeCord se versiona por build de Jenkins, no por MC.
    Ok(vec!["latest".to_string()])
}

async fn list_quilt_versions() -> Result<Vec<String>, String> {
    let v = fetch_json("https://meta.quiltmc.org/v3/versions/game").await?;
    Ok(v.as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| {
            item.get("stable")
                .and_then(|s| s.as_bool())
                .unwrap_or(false)
        })
        .filter_map(|item| {
            item.get("version")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        })
        .collect())
}

async fn list_fabric_versions() -> Result<Vec<String>, String> {
    let v = fetch_json("https://meta.fabricmc.net/v2/versions/game").await?;
    Ok(v.as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| {
            item.get("stable")
                .and_then(|s| s.as_bool())
                .unwrap_or(false)
        })
        .filter_map(|item| {
            item.get("version")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        })
        .collect())
}

async fn list_vanilla_versions() -> Result<Vec<String>, String> {
    let v = fetch_json("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json").await?;
    Ok(v.get("versions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item.get("type").and_then(|t| t.as_str()) == Some("release"))
        .filter_map(|item| {
            item.get("id")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        })
        .collect())
}

async fn list_forge_versions() -> Result<Vec<String>, String> {
    let v =
        fetch_json("https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json")
            .await?;
    let mut all: Vec<String> = v
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    all.sort_by(|a, b| semver_cmp(b, a));
    Ok(all)
}

async fn list_neoforge_versions() -> Result<Vec<String>, String> {
    let xml = fetch_text(
        "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
    )
    .await?;
    let mut all: Vec<String> = Vec::new();
    let mut rest = xml.as_str();
    while let Some(start) = rest.find("<version>") {
        rest = &rest[start + 9..];
        if let Some(end) = rest.find("</version>") {
            let ver = rest[..end].trim();
            if !ver.is_empty() {
                all.push(ver.to_string());
            }
            rest = &rest[end + 10..];
        } else {
            break;
        }
    }
    all.reverse();
    Ok(all)
}

#[derive(Deserialize)]
struct VersionsBuildsQuery {
    software: Option<String>,
    version: Option<String>,
}

async fn versions_builds(Query(q): Query<VersionsBuildsQuery>) -> Response {
    let sw = q.software.unwrap_or_default();
    let version = q.version.unwrap_or_default();
    if sw.is_empty() || version.is_empty() {
        return json_fail("software y version requeridos");
    }

    let res: Result<Vec<serde_json::Value>, String> = match sw.as_str() {
        "paper" | "folia" | "velocity" | "waterfall" => builds_papermc(&sw, &version).await,
        "purpur" => builds_purpur(&version).await,
        "leaves" => builds_leaves(&version).await,
        "leaf" => builds_mcjars("Leaf", &version).await,
        "spigot" => builds_spigot(&version).await,
        "bukkit" => builds_bukkit(&version).await,
        "mohist" => builds_mcjars("Mohist", &version).await,
        "arclight" => builds_mcjars("Arclight", &version).await,
        "magma" => builds_mcjars("Magma", &version).await,
        "spongevanilla" | "spongeforge" | "spongeneo" => builds_sponge(&sw, &version).await,
        "fabric" => builds_fabric(&version).await,
        "quilt" => builds_quilt(&version).await,
        "vanilla" => builds_vanilla(&version).await,
        "forge" => builds_forge(&version).await,
        "neoforge" => builds_neoforge(&version).await,
        "bungeecord" => builds_bungeecord(&version).await,
        _ => Err(format!("Software no soportado: {sw}")),
    };

    match res {
        Ok(v) => json_ok(json!({ "builds": v })),
        Err(e) => json_fail(&e),
    }
}

async fn builds_papermc(sw: &str, version: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!(
        "https://fill.papermc.io/v3/projects/{}/versions/{}/builds",
        sw, version
    );
    let v = fetch_json(&url).await?;
    let mut out = Vec::new();
    if let Some(arr) = v.as_array() {
        for b in arr {
            let build = b.get("build").and_then(|v| v.as_i64()).unwrap_or(0);
            let channel = b
                .get("channel")
                .and_then(|c| c.as_str())
                .unwrap_or("STABLE");
            let time = b
                .get("time")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            let download = b
                .get("downloads")
                .and_then(|d| d.get("server:default"))
                .cloned()
                .unwrap_or_default();
            let url = download
                .get("url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string();
            let sha256 = download
                .get("sha256")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let changes: Vec<String> = b
                .get("changes")
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| {
                            item.get("summary")
                                .and_then(|s| s.as_str())
                                .map(|s| s.to_string())
                        })
                        .take(3)
                        .collect()
                })
                .unwrap_or_default();
            out.push(json!({
                "build": build, "channel": channel, "time": time,
                "url": url, "sha256": sha256, "changes": changes.join(" · "),
            }));
        }
    }
    out.sort_by(|a, b| {
        let ba = a.get("build").and_then(|v| v.as_i64()).unwrap_or(0);
        let bb = b.get("build").and_then(|v| v.as_i64()).unwrap_or(0);
        bb.cmp(&ba)
    });
    Ok(out)
}

async fn builds_purpur(version: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("https://api.purpurmc.org/v2/purpur/{}", version);
    let v = fetch_json(&url).await?;
    let all = v
        .get("builds")
        .and_then(|b| b.get("all"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for item in all.iter().rev() {
        let b = item.as_str().unwrap_or("");
        out.push(json!({
            "build": b, "channel": "STABLE", "time": null,
            "url": format!("https://api.purpurmc.org/v2/purpur/{}/{}/download", version, b),
            "sha256": null, "changes": "",
        }));
    }
    Ok(out)
}

async fn builds_fabric(version: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("https://meta.fabricmc.net/v2/versions/loader/{}", version);
    let v = fetch_json(&url).await?;
    let mut out = Vec::new();
    if let Some(arr) = v.as_array() {
        for item in arr {
            let loader = item.get("loader").cloned().unwrap_or_default();
            if !loader
                .get("stable")
                .and_then(|s| s.as_bool())
                .unwrap_or(false)
            {
                continue;
            }
            let lv = loader.get("version").and_then(|v| v.as_str()).unwrap_or("");
            let build = loader.get("build").and_then(|v| v.as_i64()).unwrap_or(0);
            out.push(json!({
                "build": build, "channel": "STABLE", "loaderVersion": lv,
                "time": null, "url": null, "sha256": null,
                "changes": format!("Fabric Loader {}", lv),
            }));
        }
    }
    Ok(out)
}

async fn builds_vanilla(version: &str) -> Result<Vec<serde_json::Value>, String> {
    let manifest =
        fetch_json("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json").await?;
    let entry = manifest
        .get("versions")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|item| item.get("id").and_then(|i| i.as_str()) == Some(version))
        })
        .cloned()
        .ok_or_else(|| format!("Versión {} no encontrada", version))?;
    let version_url = entry
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or_else(|| "URL de versión no disponible".to_string())?;
    let data = fetch_json(version_url).await?;
    let server = data
        .get("downloads")
        .and_then(|d| d.get("server"))
        .cloned()
        .ok_or_else(|| "No hay descarga de servidor".to_string())?;
    let url = server
        .get("url")
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();
    let sha1 = server
        .get("sha1")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let release_time = entry
        .get("releaseTime")
        .and_then(|t| t.as_str())
        .unwrap_or("");
    Ok(vec![json!({
        "build": 1, "channel": "STABLE", "time": release_time,
        "url": url, "sha256": sha1,
        "changes": format!("Minecraft {} — oficial de Mojang", version),
    })])
}

async fn builds_leaves(version: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("https://api.leavesmc.org/v2/projects/leaves/versions/{version}");
    let v = fetch_json(&url).await?;
    let builds = v
        .get("builds")
        .and_then(|b| b.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for b in builds.iter().rev().take(25) {
        let build = b.as_i64().unwrap_or(0);
        if build <= 0 {
            continue;
        }
        out.push(json!({
            "build": build,
            "channel": "RELEASE",
            "time": null,
            "url": format!(
                "https://api.leavesmc.org/v2/projects/leaves/versions/{version}/builds/{build}/downloads/application"
            ),
            "sha256": null,
            "changes": format!("Leaves {version} build {build}"),
        }));
    }
    Ok(out)
}

async fn builds_quilt(version: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("https://meta.quiltmc.org/v3/versions/loader/{version}");
    let v = fetch_json(&url).await?;
    let arr = v.as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for item in arr.iter().take(15) {
        let loader = item
            .pointer("/loader/version")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        if loader.is_empty() {
            continue;
        }
        out.push(json!({
            "build": loader.clone(),
            "channel": "RELEASE",
            "time": null,
            "loaderVersion": loader.clone(),
            "url": null,
            "sha256": null,
            "changes": format!("Quilt Loader {loader} para Minecraft {version}"),
        }));
    }
    Ok(out)
}

async fn builds_spigot(version: &str) -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![json!({
        "build": "getbukkit",
        "channel": "RELEASE",
        "time": null,
        "url": format!("https://download.getbukkit.org/spigot/spigot-{version}.jar"),
        "sha256": null,
        "changes": format!(
            "Spigot {version} vía GetBukkit (mirror no oficial). Para builds oficiales usa BuildTools."
        ),
    })])
}

async fn builds_bukkit(version: &str) -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![json!({
        "build": "getbukkit",
        "channel": "RELEASE",
        "time": null,
        "url": format!("https://download.getbukkit.org/craftbukkit/craftbukkit-{version}.jar"),
        "sha256": null,
        "changes": format!(
            "CraftBukkit {version} vía GetBukkit (mirror no oficial)."
        ),
    })])
}

async fn builds_mcjars(project: &str, version: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("https://mcjars.app/api/v2/builds/{project}/{version}");
    let v = fetch_json(&url).await?;
    let arr = v
        .get("builds")
        .and_then(|b| b.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for b in arr.iter().take(30) {
        let name = b
            .get("name")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let build_number = b.get("buildNumber").and_then(|n| n.as_i64()).unwrap_or(0);
        let jar_url = b
            .get("jarUrl")
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                b.get("zipUrl")
                    .and_then(|s| s.as_str())
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or("")
            .to_string();
        if jar_url.is_empty() {
            continue;
        }
        let is_zip = jar_url.ends_with(".zip");
        let experimental = b
            .get("experimental")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let time = b
            .get("created")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let changes: String = b
            .get("changes")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str().map(|s| s.to_string()))
                    .take(3)
                    .collect::<Vec<_>>()
                    .join(" · ")
            })
            .unwrap_or_default();
        let label = if name.is_empty() {
            build_number.to_string()
        } else {
            name.clone()
        };
        let mut notes = if changes.is_empty() {
            format!("{project} {version} · {label}")
        } else {
            changes
        };
        if is_zip {
            notes.push_str(" · descarga ZIP (extraer server.jar si hace falta)");
        }
        out.push(json!({
            "build": label,
            "channel": if experimental { "PRERELEASE" } else { "RELEASE" },
            "time": time,
            "url": jar_url,
            "sha256": null,
            "changes": notes,
        }));
    }
    Ok(out)
}

async fn builds_bungeecord(_version: &str) -> Result<Vec<serde_json::Value>, String> {
    // Último build estable + artefacto directo del CI de md_5.
    let mut out = Vec::new();
    out.push(json!({
        "build": "lastSuccessful",
        "channel": "RELEASE",
        "time": null,
        "url": "https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar",
        "sha256": null,
        "changes": "Último build exitoso de BungeeCord (CI md_5).",
    }));
    // Builds recientes por número (aproximación: leer lastSuccessful buildNumber si es posible)
    if let Ok(text) =
        fetch_text("https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/buildNumber").await
        && let Ok(n) = text.trim().parse::<i64>()
    {
        for build in ((n - 14).max(1)..=n).rev() {
            out.push(json!({
                    "build": build,
                    "channel": "RELEASE",
                    "time": null,
                    "url": format!(
                        "https://ci.md-5.net/job/BungeeCord/{build}/artifact/bootstrap/target/BungeeCord.jar"
                    ),
                    "sha256": null,
                    "changes": format!("BungeeCord Jenkins build {build}"),
                }));
        }
    }
    Ok(out)
}

async fn builds_forge(version: &str) -> Result<Vec<serde_json::Value>, String> {
    let v =
        fetch_json("https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json")
            .await?;
    let arr = v
        .get(version)
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for item in arr.iter().rev() {
        let forge_version = item.as_str().unwrap_or("");
        let full = if forge_version.starts_with(version) {
            forge_version.to_string()
        } else {
            format!("{}-{}", version, forge_version)
        };
        out.push(json!({
            "build": full, "channel": "RELEASE", "time": null,
            "loaderVersion": full,
            "url": format!(
                "https://maven.minecraftforge.net/net/minecraftforge/forge/{0}/forge-{0}-installer.jar",
                full
            ),
            "sha256": null,
            "changes": format!("Forge {} para Minecraft {}", full, version),
        }));
    }
    Ok(out)
}

async fn builds_neoforge(version: &str) -> Result<Vec<serde_json::Value>, String> {
    let build = version;
    Ok(vec![json!({
        "build": build,
        "channel": if build.contains("-beta") || build.contains("-alpha") { "PRERELEASE" } else { "RELEASE" },
        "time": null,
        "url": format!(
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/{0}/neoforge-{0}-installer.jar",
            build
        ),
        "sha256": null,
        "changes": format!("NeoForge {} · instalador oficial", build),
    })])
}

/// Comprueba que el jar del instalador existe, tiene tamaño razonable y es un ZIP válido.
async fn installer_jar_ready(path: &Path) -> bool {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => return false,
        };
        let meta = match file.metadata() {
            Ok(m) => m,
            Err(_) => return false,
        };
        // Instaladores reales (Fabric/Quilt/Forge/NeoForge) pesan mucho más.
        if meta.len() < 32_768 {
            return false;
        }
        zip::ZipArchive::new(file).is_ok()
    })
    .await
    .unwrap_or(false)
}

#[derive(Deserialize)]
struct VersionsInstallBody {
    software: Option<String>,
    version: Option<String>,
    build: Option<String>,
    url: Option<String>,
    #[serde(rename = "loaderVersion")]
    loader_version: Option<String>,
}

async fn versions_install(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<VersionsInstallBody>,
) -> Response {
    {
        let s = st.app.read().await;
        if check_auth(&headers, &s.config.local_token).is_err() {
            return StatusCode::UNAUTHORIZED.into_response();
        }
    }

    let sw = body.software.unwrap_or_default();
    let version = body.version.unwrap_or_default();
    if sw.is_empty() || version.is_empty() {
        return json_fail("software y version requeridos");
    }

    let server_dir = {
        let s = st.app.read().await;
        s.config.server_dir.clone()
    };

    if sw == "fabric" {
        let loader = body.loader_version.unwrap_or_default();
        if loader.is_empty() {
            return json_fail("loaderVersion requerido para Fabric");
        }
        let inst_url = match fetch_json("https://meta.fabricmc.net/v2/versions/installer").await {
            Ok(v) => v
                .as_array()
                .and_then(|arr| {
                    arr.iter()
                        .find(|i| i.get("stable").and_then(|s| s.as_bool()).unwrap_or(false))
                })
                .and_then(|i| i.get("url").and_then(|u| u.as_str()).map(|s| s.to_string()))
                .unwrap_or_default(),
            Err(_) => String::new(),
        };
        if inst_url.is_empty() {
            return json_fail("No se encontró installer de Fabric");
        }
        let inst_name = "fabric-installer.jar".to_string();
        let inst_path = server_dir.join(&inst_name);
        let installer_ready = installer_jar_ready(&inst_path).await;
        if !installer_ready {
            let _ = tokio::fs::remove_file(&inst_path).await;
            if let Err(e) = download_to(&inst_url, &inst_path).await {
                let _ = tokio::fs::remove_file(&inst_path).await;
                return json_fail(&format!("Descarga installer falló: {e}"));
            }
            if !installer_jar_ready(&inst_path).await {
                let _ = tokio::fs::remove_file(&inst_path).await;
                return json_fail(
                    "El instalador descargado no es un JAR válido; inténtalo de nuevo.",
                );
            }
        }
        return json_ok(json!({
            "type": "fabric-installer",
            "installCmd": format!(
                "java -jar {} server -mcversion {} -loader {} -downloadMinecraft",
                inst_name, version, loader
            ),
            "jarName": "fabric-server-launch.jar",
            "note": "Fabric preparado. Ejecuta el comando desde la carpeta del servidor para completar la instalación.",
        }));
    }

    if sw == "quilt" {
        let loader = body
            .loader_version
            .clone()
            .or_else(|| body.build.clone())
            .unwrap_or_default();
        if loader.is_empty() {
            return json_fail("loaderVersion o build requerido");
        }
        let inst_url = match fetch_json("https://meta.quiltmc.org/v3/versions/installer").await {
            Ok(v) => v
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|item| item.get("url"))
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string(),
            Err(e) => return json_fail(&format!("No se pudo obtener installer de Quilt: {e}")),
        };
        if inst_url.is_empty() {
            return json_fail("Installer de Quilt no disponible");
        }
        let inst_name = "quilt-installer.jar".to_string();
        let inst_path = server_dir.join(&inst_name);
        let installer_ready = installer_jar_ready(&inst_path).await;
        if !installer_ready {
            let _ = tokio::fs::remove_file(&inst_path).await;
            if let Err(e) = download_to(&inst_url, &inst_path).await {
                let _ = tokio::fs::remove_file(&inst_path).await;
                return json_fail(&format!("Descarga installer falló: {e}"));
            }
            if !installer_jar_ready(&inst_path).await {
                let _ = tokio::fs::remove_file(&inst_path).await;
                return json_fail(
                    "El instalador descargado no es un JAR válido; inténtalo de nuevo.",
                );
            }
        }
        return json_ok(json!({
            "type": "quilt-installer",
            "installCmd": format!(
                "java -jar {} server version {} loader {}",
                inst_name, version, loader
            ),
            "jarName": "quilt-server-launch.jar",
            "note": "Quilt preparado. Ejecuta el comando desde la carpeta del servidor para completar la instalación.",
        }));
    }

    if sw == "forge" || sw == "neoforge" {
        let b = body.build.unwrap_or_default();
        if b.is_empty() {
            return json_fail("build requerido");
        }
        let url = body.url.unwrap_or_else(|| {
            if sw == "forge" {
                format!(
                    "https://maven.minecraftforge.net/net/minecraftforge/forge/{0}/forge-{0}-installer.jar",
                    b
                )
            } else {
                format!(
                    "https://maven.neoforged.net/releases/net/neoforged/neoforge/{0}/neoforge-{0}-installer.jar",
                    b
                )
            }
        });
        let inst_name = format!("{}-installer.jar", sw);
        let inst_path = server_dir.join(&inst_name);
        let installer_ready = installer_jar_ready(&inst_path).await;
        if !installer_ready {
            let _ = tokio::fs::remove_file(&inst_path).await;
            if let Err(e) = download_to(&url, &inst_path).await {
                let _ = tokio::fs::remove_file(&inst_path).await;
                return json_fail(&format!("Descarga installer falló: {e}"));
            }
            if !installer_jar_ready(&inst_path).await {
                let _ = tokio::fs::remove_file(&inst_path).await;
                return json_fail(
                    "El instalador descargado no es un JAR válido; inténtalo de nuevo.",
                );
            }
        }
        return json_ok(json!({
            "type": format!("{}-installer", sw),
            "installCmd": format!("java -jar {} --installServer", inst_name),
            "jarName": "run.bat",
            "note": format!("{} descargado. Ejecuta el comando para completar la instalación.", sw),
        }));
    }

    let url = match body.url {
        Some(u) if !u.is_empty() => u,
        _ => return json_fail("URL de descarga requerida"),
    };

    let temp = {
        let mut id = [0u8; 8];
        {
            use rand::Rng;
            rand::rng().fill_bytes(&mut id);
        }
        let id = id.iter().map(|b| format!("{b:02x}")).collect::<String>();
        server_dir.join(format!(".moonwolf-server-download-{id}"))
    };
    if let Err(e) = download_to(&url, &temp).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return json_fail(&format!("Descarga falló: {e}"));
    }

    let current = server_dir.join("server.jar");
    let backup = server_dir.join(format!("server.bak_{}.jar", crate::now_secs()));

    if current.exists() {
        if let Err(e) = tokio::fs::rename(&current, &backup).await {
            let _ = tokio::fs::remove_file(&temp).await;
            return json_fail(&format!(
                "No se pudo apartar el server.jar actual (¿en uso?): {e}"
            ));
        }
    }
    if let Err(e) = replace_file(&temp, &current).await {
        if backup.exists() {
            let _ = tokio::fs::rename(&backup, &current).await;
        }
        let _ = tokio::fs::remove_file(&temp).await;
        return json_fail(&format!("No se pudo mover el nuevo server.jar: {e}"));
    }

    let size_mb = tokio::fs::metadata(&current)
        .await
        .map(|m| m.len() as f64 / 1024.0 / 1024.0)
        .unwrap_or(0.0);

    json_ok(json!({
        "type": "direct",
        "filename": "server.jar",
        "size": format!("{:.2} MB", size_mb),
        "software": sw,
        "version": version,
        "note": "server.jar actualizado correctamente.",
    }))
}

/* ══════════════════════════════════════════════
PLUGINS
══════════════════════════════════════════════ */

fn plugins_dir(server_dir: &Path) -> PathBuf {
    server_dir.join("plugins")
}

#[derive(Deserialize)]
struct PluginsSearchQuery {
    q: Option<String>,
    source: Option<String>,
}

async fn plugins_search(Query(q): Query<PluginsSearchQuery>) -> Response {
    let query = q.q.unwrap_or_default();
    if query.trim().is_empty() {
        return json_fail("Query vacía");
    }
    let source = q.source.unwrap_or_else(|| "all".into());
    let q_enc = urlencode(&query);

    let mut results = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    if (source == "all" || source == "modrinth")
        && let Err(e) = search_modrinth(&q_enc, &mut results).await
    {
        errors.push(format!("Modrinth: {e}"));
    }
    if (source == "all" || source == "spigot")
        && let Err(e) = search_spiget(&q_enc, &mut results).await
    {
        errors.push(format!("SpigotMC: {e}"));
    }
    if (source == "all" || source == "hangar")
        && let Err(e) = search_hangar(&q_enc, &mut results).await
    {
        errors.push(format!("Hangar: {e}"));
    }

    json_ok(json!({ "results": results, "errors": errors }))
}
async fn search_modrinth(q: &str, out: &mut Vec<serde_json::Value>) -> Result<(), String> {
    let url = format!(
        "https://api.modrinth.com/v2/search?query={}&limit=10&facets=[[\"project_type:plugin\"]]",
        q
    );
    let v = fetch_json(&url).await?;
    if let Some(hits) = v.get("hits").and_then(|h| h.as_array()) {
        for p in hits {
            out.push(json!({
                "id": p.get("project_id").and_then(|x| x.as_str()).unwrap_or(""),
                "name": p.get("title").and_then(|x| x.as_str()).unwrap_or(""),
                "description": p.get("description").and_then(|x| x.as_str()).unwrap_or(""),
                "icon": p.get("icon_url").and_then(|x| x.as_str()),
                "downloads": p.get("downloads").and_then(|x| x.as_i64()).unwrap_or(0),
                "source": "modrinth",
                "gameVersions": p.get("game_versions").cloned().unwrap_or(json!([])),
                "categories": p.get("categories").cloned().unwrap_or(json!([])),
                "premium": false,
                "external": false,
            }));
        }
    }
    Ok(())
}

async fn search_spiget(q: &str, out: &mut Vec<serde_json::Value>) -> Result<(), String> {
    let url = format!(
        "https://api.spiget.org/v2/search/resources/{}?size=10&field=name",
        q
    );
    let v = fetch_json(&url).await?;
    if let Some(arr) = v.as_array() {
        for p in arr {
            let id = p.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
            let name = p.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let tag = p
                .get("tag")
                .and_then(|x| x.as_str())
                .unwrap_or("Plugin desde SpigotMC");
            let downloads = p.get("downloads").and_then(|x| x.as_i64()).unwrap_or(0);
            let external = p.get("external").and_then(|x| x.as_bool()).unwrap_or(false);
            let premium = p.get("premium").and_then(|x| x.as_bool()).unwrap_or(false);
            out.push(json!({
                "id": id.to_string(),
                "name": name,
                "description": tag,
                "icon": format!("https://api.spiget.org/v2/resources/{}/icon", id),
                "downloads": downloads,
                "source": "spigot",
                "external": external,
                "premium": premium,
                "gameVersions": [],
                "categories": [],
            }));
        }
    }
    Ok(())
}

async fn search_hangar(q: &str, out: &mut Vec<serde_json::Value>) -> Result<(), String> {
    let url = format!(
        "https://hangar.papermc.io/api/v1/projects?limit=10&offset=0&q={}&sort=-stars",
        q
    );
    let v = fetch_json(&url).await?;
    if let Some(arr) = v.get("result").and_then(|r| r.as_array()) {
        for p in arr {
            let ns = p.get("namespace").cloned().unwrap_or_default();
            let owner = ns.get("owner").and_then(|x| x.as_str()).unwrap_or("");
            let slug = ns.get("slug").and_then(|x| x.as_str()).unwrap_or("");
            let downloads = p
                .get("stats")
                .and_then(|s| s.get("downloads"))
                .and_then(|d| d.as_i64())
                .unwrap_or(0);
            out.push(json!({
                "id": format!("{}/{}", owner, slug),
                "name": p.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                "description": p.get("description").and_then(|x| x.as_str()).unwrap_or(""),
                "icon": p.get("avatarUrl").and_then(|x| x.as_str()),
                "downloads": downloads,
                "source": "hangar",
                "gameVersions": [],
                "categories": p.get("category").and_then(|c| c.as_str()).map(|c| json!([c])).unwrap_or(json!([])),
                "premium": false,
                "external": false,
            }));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct PluginsVersionsQuery {
    id: Option<String>,
    source: Option<String>,
}

async fn plugins_versions(Query(q): Query<PluginsVersionsQuery>) -> Response {
    let id = q.id.unwrap_or_default();
    let source = q.source.unwrap_or_default();
    if id.is_empty() || source.is_empty() {
        return json_fail("id y source requeridos");
    }

    let res: Result<Vec<serde_json::Value>, String> = match source.as_str() {
        "modrinth" => plugin_versions_modrinth(&id).await,
        "spigot" => plugin_versions_spiget(&id).await,
        "hangar" => plugin_versions_hangar(&id).await,
        _ => Err(format!("Fuente no soportada: {source}")),
    };

    match res {
        Ok(v) => json_ok(json!({ "versions": v })),
        Err(e) => json_fail(&e),
    }
}

async fn plugin_versions_modrinth(id: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("https://api.modrinth.com/v2/project/{}/version", id);
    let v = fetch_json(&url).await?;
    let mut out = Vec::new();
    if let Some(arr) = v.as_array() {
        for ver in arr {
            let files = ver
                .get("files")
                .and_then(|f| f.as_array())
                .cloned()
                .unwrap_or_default();
            let files_json: Vec<serde_json::Value> = files
                .into_iter()
                .map(|f| {
                    json!({
                        "primary": f.get("primary").and_then(|p| p.as_bool()).unwrap_or(false),
                        "url": f.get("url").and_then(|u| u.as_str()).unwrap_or(""),
                        "filename": f.get("filename").and_then(|n| n.as_str()).unwrap_or(""),
                    })
                })
                .collect();
            out.push(json!({
                "versionId": ver.get("id").and_then(|x| x.as_str()).unwrap_or(""),
                "versionNumber": ver.get("version_number").and_then(|x| x.as_str()).unwrap_or(""),
                "name": ver.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                "downloads": ver.get("downloads").and_then(|x| x.as_i64()).unwrap_or(0),
                "published": ver.get("date_published").and_then(|x| x.as_str()),
                "gameVersions": ver.get("game_versions").cloned().unwrap_or(json!([])),
                "loaders": ver.get("loaders").cloned().unwrap_or(json!([])),
                "changelog": ver.get("changelog").and_then(|c| c.as_str()),
                "files": files_json,
                "isExternal": false,
            }));
        }
    }
    Ok(out)
}

async fn plugin_versions_spiget(id: &str) -> Result<Vec<serde_json::Value>, String> {
    let resource = fetch_json(&format!("https://api.spiget.org/v2/resources/{}", id)).await?;
    let premium = resource
        .get("premium")
        .and_then(|p| p.as_bool())
        .unwrap_or(false);
    let external = resource
        .get("external")
        .and_then(|p| p.as_bool())
        .unwrap_or(false);
    let can_download = !premium && !external;
    let resource_page = format!("https://www.spigotmc.org/resources/{}/", id);

    let raw = fetch_json(&format!(
        "https://api.spiget.org/v2/resources/{}/versions?size=20&sort=-releaseDate",
        id
    ))
    .await?;

    let mut out = Vec::new();
    if let Some(arr) = raw.as_array() {
        for ver in arr {
            let vid = ver.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
            let label = ver.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let published = ver
                .get("releaseDate")
                .and_then(|x| x.as_i64())
                .map(|s| s * 1000);
            let downloads = ver.get("downloads").and_then(|x| x.as_i64()).unwrap_or(0);
            let safe_name = format!("plugin-{}-{}.jar", id, vid);
            out.push(json!({
                "versionId": vid.to_string(),
                "versionNumber": label,
                "published": published,
                "downloads": downloads,
                "isExternal": !can_download,
                "externalUrl": if !can_download { Some(resource_page.clone()) } else { None },
                "changelog": null,
                "changelogIsHtml": false,
                "files": if can_download {
                    vec![json!({
                        "primary": true,
                        "url": format!("https://api.spiget.org/v2/resources/{}/versions/{}/download", id, vid),
                        "filename": safe_name,
                    })]
                } else {
                    vec![]
                },
            }));
        }
    }

    if out.is_empty() {
        out.push(json!({
            "versionId": "external",
            "versionNumber": "Ver en SpigotMC",
            "isExternal": true,
            "externalUrl": resource_page,
            "files": [],
        }));
    }
    Ok(out)
}

async fn plugin_versions_hangar(id: &str) -> Result<Vec<serde_json::Value>, String> {
    let (owner, slug) = id
        .split_once('/')
        .ok_or_else(|| "ID de Hangar inválido (formato owner/slug)".to_string())?;
    let project_page = format!("https://hangar.papermc.io/{}/{}", owner, slug);
    let raw = fetch_json(&format!(
        "https://hangar.papermc.io/api/v1/projects/{}/{}/versions?limit=20&offset=0",
        owner, slug
    ))
    .await?;

    let mut out = Vec::new();
    if let Some(arr) = raw.get("result").and_then(|r| r.as_array()) {
        for ver in arr {
            let name = ver.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let created = ver.get("createdAt").and_then(|x| x.as_str());
            let downloads = ver.get("downloads").cloned().unwrap_or_default();
            let platforms: Vec<&str> = downloads
                .as_object()
                .map(|o| o.keys().map(|s| s.as_str()).collect())
                .unwrap_or_default();
            let platform = platforms
                .iter()
                .find(|p| **p == "PAPER")
                .copied()
                .or_else(|| platforms.first().copied());

            let is_external = platform.is_none();
            let file_url = platform.map(|p| {
                format!(
                    "https://hangar.papermc.io/api/v1/projects/{}/{}/versions/{}/{}/download",
                    owner, slug, name, p
                )
            });
            out.push(json!({
                "versionId": name,
                "versionNumber": name,
                "published": created,
                "isExternal": is_external,
                "externalUrl": if is_external { Some(format!("{}/versions/{}", project_page, name)) } else { None },
                "changelog": ver.get("description").and_then(|x| x.as_str()),
                "changelogIsHtml": false,
                "files": if !is_external {
                    vec![json!({
                        "primary": true,
                        "url": file_url.unwrap_or_default(),
                        "filename": format!("{}-{}.jar", slug, name),
                    })]
                } else {
                    vec![]
                },
            }));
        }
    }

    if out.is_empty() {
        out.push(json!({
            "versionId": "external",
            "versionNumber": "Ver en Hangar",
            "isExternal": true,
            "externalUrl": project_page,
            "files": [],
        }));
    }
    Ok(out)
}

#[derive(Deserialize)]
struct PluginsInstallBody {
    url: Option<String>,
    filename: Option<String>,
}

async fn plugins_install(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Json(body): Json<PluginsInstallBody>,
) -> Response {
    {
        let s = st.app.read().await;
        if check_auth(&headers, &s.config.local_token).is_err() {
            return StatusCode::UNAUTHORIZED.into_response();
        }
    }

    let url = body.url.unwrap_or_default();
    let filename = body.filename.unwrap_or_default();

    if url.is_empty() || filename.is_empty() {
        return json_fail("url y filename requeridos");
    }
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return json_fail("Nombre de archivo no válido");
    }
    if !filename.to_lowercase().ends_with(".jar") {
        return json_fail("El archivo debe ser .jar");
    }

    let server_dir = {
        let s = st.app.read().await;
        s.config.server_dir.clone()
    };

    let dir = plugins_dir(&server_dir);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return json_fail(&format!("No se pudo crear plugins/: {e}"));
    }

    let dest = dir.join(&filename);

    if let Err(e) = download_to(&url, &dest).await {
        return json_fail(&format!("Descarga falló: {e}"));
    }

    let size_mb = tokio::fs::metadata(&dest)
        .await
        .map(|m| m.len() as f64 / 1024.0 / 1024.0)
        .unwrap_or(0.0);

    json_ok(json!({
        "filename": filename,
        "size": format!("{:.2} MB", size_mb),
    }))
}

async fn plugins_installed(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let server_dir = {
        let s = st.app.read().await;
        check_auth(&headers, &s.config.local_token)?;
        s.config.server_dir.clone()
    };
    let dir = plugins_dir(&server_dir);
    if !dir.exists() {
        return Ok(json_ok(json!({ "plugins": [] })));
    }

    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(_) => return Ok(json_ok(json!({ "plugins": [] }))),
    };
    let mut plugins = Vec::new();
    while let Ok(Some(ent)) = rd.next_entry().await {
        let name = ent.file_name().to_string_lossy().to_string();
        if !name.to_lowercase().ends_with(".jar") {
            continue;
        }
        let meta = match ent.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size_mb = meta.len() as f64 / 1024.0 / 1024.0;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| crate::format_datetime_secs(d.as_secs() as i64))
            .unwrap_or_default();
        plugins.push(json!({
            "filename": name,
            "size": format!("{:.2} MB", size_mb),
            "modified": modified,
        }));
    }

    plugins.sort_by(|a, b| {
        a.get("filename")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .cmp(b.get("filename").and_then(|x| x.as_str()).unwrap_or(""))
    });

    Ok(json_ok(json!({ "plugins": plugins })))
}

async fn plugins_delete(
    State(st): State<LocalState>,
    headers: HeaderMap,
    AxumPath(filename): AxumPath<String>,
) -> Response {
    {
        let s = st.app.read().await;
        if check_auth(&headers, &s.config.local_token).is_err() {
            return StatusCode::UNAUTHORIZED.into_response();
        }
    }

    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return json_fail("Nombre no válido");
    }
    if !filename.to_lowercase().ends_with(".jar") {
        return json_fail("Solo se pueden borrar archivos .jar");
    }

    let server_dir = {
        let s = st.app.read().await;
        s.config.server_dir.clone()
    };
    let path = plugins_dir(&server_dir).join(&filename);
    if !path.is_file() {
        return json_fail("El plugin no existe");
    }

    match tokio::fs::remove_file(&path).await {
        Ok(()) => json_ok(json!({})),
        Err(e) => json_fail(&format!("No se pudo eliminar: {e}")),
    }
}

/* ══════════════════════════════════════════════
DATABASES
══════════════════════════════════════════════ */

static MYSQL_POOL: tokio::sync::OnceCell<sqlx::MySqlPool> = tokio::sync::OnceCell::const_new();

async fn mysql_pool() -> Result<&'static sqlx::MySqlPool, sqlx::Error> {
    MYSQL_POOL
        .get_or_try_init(|| async {
            let host = std::env::var("MOONWOLF_MYSQL_HOST").unwrap_or_else(|_| "localhost".into());
            let port = std::env::var("MOONWOLF_MYSQL_PORT").unwrap_or_else(|_| "3306".into());
            let user = std::env::var("MOONWOLF_MYSQL_USER").unwrap_or_else(|_| "root".into());
            let password = std::env::var("MOONWOLF_MYSQL_PASSWORD").unwrap_or_default();

            let url = format!(
                "mysql://{}:{}@{}:{}/",
                urlencode(&user),
                urlencode(&password),
                host,
                port
            );

            sqlx::mysql::MySqlPoolOptions::new()
                .max_connections(8)
                .min_connections(0)
                .acquire_timeout(std::time::Duration::from_secs(10))
                .idle_timeout(std::time::Duration::from_secs(1800))
                .connect(&url)
                .await
        })
        .await
}

fn valid_db_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 48
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !matches!(
            name.to_ascii_lowercase().as_str(),
            "information_schema" | "mysql" | "performance_schema" | "sys"
        )
}

/// MySQL limita el nombre de usuario a 32 caracteres. Si el nombre de la BD
/// cabe, se reutiliza tal cual (es único). Si es más largo, se combina un
/// prefijo con un hash estable del nombre completo para evitar colisiones.
fn mysql_username_for_db(db_name: &str) -> String {
    if db_name.len() <= 32 {
        return db_name.to_string();
    }
    let mut h: u64 = 0xcbf29ce484222325;
    for b in db_name.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    let hash = format!("{h:08x}");
    let prefix_len = 32usize.saturating_sub(1 + hash.len());
    let prefix: String = db_name.chars().take(prefix_len).collect();
    format!("{prefix}_{hash}")
}

fn gen_db_password() -> String {
    let mut bytes = [0u8; 18];
    rand::rng().fill_bytes(&mut bytes);
    crate::b64_std_encode(&bytes)
        .replace(['+', '/', '='], "")
        .chars()
        .take(20)
        .collect()
}

async fn db_status() -> Response {
    let host = std::env::var("MOONWOLF_MYSQL_HOST").unwrap_or_else(|_| "localhost".into());
    let port = std::env::var("MOONWOLF_MYSQL_PORT").unwrap_or_else(|_| "3306".into());

    match mysql_pool().await {
        Ok(pool) => match sqlx::query_scalar::<_, i64>("SELECT 1")
            .fetch_one(pool)
            .await
        {
            Ok(_) => json_ok(json!({
                "connected": true,
                "host": host,
                "port": port,
            })),
            Err(e) => json_ok(json!({
                "connected": false,
                "error": e.to_string(),
                "host": host,
                "port": port,
            })),
        },
        Err(e) => json_ok(json!({
            "connected": false,
            "error": e.to_string(),
            "host": host,
            "port": port,
        })),
    }
}

async fn db_list() -> Response {
    let pool = match mysql_pool().await {
        Ok(p) => p,
        Err(e) => return json_fail(&format!("MySQL: {e}")),
    };

    let query = "SELECT s.SCHEMA_NAME AS name, \
        COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS sizeBytes, \
        COUNT(t.TABLE_NAME) AS tableCount \
        FROM information_schema.SCHEMATA s \
        LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME \
        WHERE s.SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') \
        GROUP BY s.SCHEMA_NAME ORDER BY s.SCHEMA_NAME";

    let rows = match sqlx::query(query).fetch_all(pool).await {
        Ok(r) => r,
        Err(e) => return json_fail(&format!("MySQL: {e}")),
    };

    let users: HashMap<String, String> = match sqlx::query("SELECT user FROM mysql.user")
        .fetch_all(pool)
        .await
    {
        Ok(user_rows) => user_rows
            .into_iter()
            .filter_map(|row| {
                let user: String = row.try_get("user").ok()?;
                Some((user.clone(), user))
            })
            .collect(),
        Err(_) => HashMap::new(),
    };

    let mut databases = Vec::new();
    for row in rows {
        let name: String = row.try_get("name").unwrap_or_default();
        let size_bytes: i64 = row.try_get("sizeBytes").unwrap_or(0);
        let tables: i64 = row.try_get("tableCount").unwrap_or(0);

        let username = mysql_username_for_db(&name);
        let user = users.get(&username).cloned();

        databases.push(json!({
            "name": name,
            "sizeMb": format!("{:.2}", size_bytes as f64 / 1024.0 / 1024.0),
            "tables": tables,
            "user": user,
        }));
    }

    json_ok(json!({ "databases": databases }))
}

#[derive(Deserialize)]
struct DbCreateBody {
    name: Option<String>,
    #[serde(rename = "createUser")]
    create_user: Option<bool>,
}

async fn db_create(Json(body): Json<DbCreateBody>) -> Response {
    let name = body.name.unwrap_or_default().trim().to_string();
    let create_user = body.create_user.unwrap_or(true);

    if !valid_db_name(&name) {
        return json_fail(
            "Nombre no válido. Usa solo letras, números y guion bajo (máx. 48 caracteres).",
        );
    }

    let pool = match mysql_pool().await {
        Ok(p) => p,
        Err(e) => return json_fail(&format!("MySQL: {e}")),
    };

    let exists: Option<String> = sqlx::query_scalar(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
    )
    .bind(&name)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    if exists.is_some() {
        return json_fail("Ya existe una base de datos con ese nombre.");
    }

    let create_db = format!(
        "CREATE DATABASE `{}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
        name.replace('`', "``")
    );
    if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(create_db))
        .execute(pool)
        .await
    {
        return json_fail(&format!("No se pudo crear: {e}"));
    }

    let mut credentials = None;

    if create_user {
        let username = mysql_username_for_db(&name);
        let password = gen_db_password();

        // Si no podemos consultar mysql.user, no asumir que el usuario no existe.
        let user_existed = match sqlx::query_scalar::<_, String>(
            "SELECT user FROM mysql.user WHERE user = ? LIMIT 1",
        )
        .bind(&username)
        .fetch_optional(pool)
        .await
        {
            Ok(row) => row.is_some(),
            Err(e) => {
                let q_drop = format!("DROP DATABASE `{}`", name.replace('`', "``"));
                let _ = sqlx::query(sqlx::AssertSqlSafe(q_drop)).execute(pool).await;
                return json_fail(&format!(
                    "No se pudo comprobar usuarios MySQL (¿permisos sobre mysql.user?): {e}"
                ));
            }
        };

        if user_existed {
            let q_drop = format!("DROP DATABASE `{}`", name.replace('`', "``"));
            let _ = sqlx::query(sqlx::AssertSqlSafe(q_drop)).execute(pool).await;
            return json_fail(
                "Ya existe un usuario MySQL con ese nombre; elige otro nombre de base de datos.",
            );
        }

        let q_user = format!(
            "CREATE USER '{}'@'%' IDENTIFIED BY '{}'",
            username.replace('\'', "''"),
            password.replace('\'', "''")
        );
        if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(q_user)).execute(pool).await {
            let q_drop = format!("DROP DATABASE `{}`", name.replace('`', "``"));
            let _ = sqlx::query(sqlx::AssertSqlSafe(q_drop)).execute(pool).await;
            return json_fail(&format!("No se pudo crear el usuario MySQL: {e}"));
        }

        // Verificar que la cuenta existe de verdad antes de devolver credenciales.
        let created_ok = match sqlx::query_scalar::<_, String>(
            "SELECT user FROM mysql.user WHERE user = ? LIMIT 1",
        )
        .bind(&username)
        .fetch_optional(pool)
        .await
        {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(e) => {
                let q_drop = format!("DROP DATABASE `{}`", name.replace('`', "``"));
                let _ = sqlx::query(sqlx::AssertSqlSafe(q_drop)).execute(pool).await;
                let q_drop_user =
                    format!("DROP USER IF EXISTS '{}'@'%'", username.replace('\'', "''"));
                let _ = sqlx::query(sqlx::AssertSqlSafe(q_drop_user))
                    .execute(pool)
                    .await;
                return json_fail(&format!(
                    "No se pudo verificar el usuario MySQL tras CREATE USER: {e}"
                ));
            }
        };
        if !created_ok {
            let q_drop = format!("DROP DATABASE `{}`", name.replace('`', "``"));
            let _ = sqlx::query(sqlx::AssertSqlSafe(q_drop)).execute(pool).await;
            return json_fail(
                "CREATE USER no dejó la cuenta en mysql.user; no se devuelven credenciales.",
            );
        }

        let q_alter = format!(
            "ALTER USER '{}'@'%' IDENTIFIED BY '{}'",
            username.replace('\'', "''"),
            password.replace('\'', "''")
        );
        if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(q_alter))
            .execute(pool)
            .await
        {
            let q_drop = format!("DROP DATABASE `{}`", name.replace('`', "``"));
            let _ = sqlx::query(sqlx::AssertSqlSafe(q_drop)).execute(pool).await;
            let q_drop_user = format!("DROP USER IF EXISTS '{}'@'%'", username.replace('\'', "''"));
            let _ = sqlx::query(sqlx::AssertSqlSafe(q_drop_user))
                .execute(pool)
                .await;
            return json_fail(&format!(
                "No se pudo establecer la contraseña del usuario: {e}"
            ));
        }

        let q_grant = format!(
            "GRANT ALL PRIVILEGES ON `{}`.* TO '{}'@'%'",
            name.replace('`', "``"),
            username.replace('\'', "''")
        );
        if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(q_grant))
            .execute(pool)
            .await
        {
            let q_drop = format!("DROP DATABASE `{}`", name.replace('`', "``"));
            let _ = sqlx::query(sqlx::AssertSqlSafe(q_drop)).execute(pool).await;
            let q_drop_user = format!("DROP USER IF EXISTS '{}'@'%'", username.replace('\'', "''"));
            let _ = sqlx::query(sqlx::AssertSqlSafe(q_drop_user))
                .execute(pool)
                .await;
            return json_fail(&format!("No se pudo asignar permisos al usuario: {e}"));
        }

        if let Err(e) = sqlx::query("FLUSH PRIVILEGES").execute(pool).await {
            let q_drop = format!("DROP DATABASE `{}`", name.replace('`', "``"));
            let _ = sqlx::query(sqlx::AssertSqlSafe(q_drop)).execute(pool).await;
            let q_drop_user = format!("DROP USER IF EXISTS '{}'@'%'", username.replace('\'', "''"));
            let _ = sqlx::query(sqlx::AssertSqlSafe(q_drop_user))
                .execute(pool)
                .await;
            return json_fail(&format!(
                "Usuario creado pero FLUSH PRIVILEGES falló; no se devuelven credenciales: {e}"
            ));
        }

        let host = std::env::var("MOONWOLF_MYSQL_HOST").unwrap_or_else(|_| "localhost".into());
        let port = std::env::var("MOONWOLF_MYSQL_PORT").unwrap_or_else(|_| "3306".into());

        credentials = Some(json!({
            "user": username,
            "password": password,
            "host": host,
            "port": port,
            "database": name,
        }));
    }

    json_ok(json!({ "name": name, "credentials": credentials }))
}

async fn db_reset(AxumPath(name): AxumPath<String>) -> Response {
    if !valid_db_name(&name) {
        return json_fail("Nombre no válido.");
    }

    let pool = match mysql_pool().await {
        Ok(p) => p,
        Err(e) => return json_fail(&format!("MySQL: {e}")),
    };

    let username = mysql_username_for_db(&name);
    let exists: Option<String> = sqlx::query_scalar("SELECT user FROM mysql.user WHERE user = ?")
        .bind(&username)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    if exists.is_none() {
        return json_fail("Esta base de datos no tiene un usuario asociado.");
    }

    let password = gen_db_password();
    let q_alter = format!(
        "ALTER USER '{}'@'%' IDENTIFIED BY '{}'",
        username.replace('\'', "''"),
        password.replace('\'', "''")
    );
    if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(q_alter))
        .execute(pool)
        .await
    {
        return json_fail(&format!("No se pudo restablecer la contraseña: {e}"));
    }

    let host = std::env::var("MOONWOLF_MYSQL_HOST").unwrap_or_else(|_| "localhost".into());
    let port = std::env::var("MOONWOLF_MYSQL_PORT").unwrap_or_else(|_| "3306".into());

    json_ok(json!({
        "credentials": {
            "user": username,
            "password": password,
            "host": host,
            "port": port,
            "database": name,
        }
    }))
}

async fn db_delete(AxumPath(name): AxumPath<String>) -> Response {
    if !valid_db_name(&name) {
        return json_fail("Nombre no válido.");
    }

    let pool = match mysql_pool().await {
        Ok(p) => p,
        Err(e) => return json_fail(&format!("MySQL: {e}")),
    };

    let q_drop = format!("DROP DATABASE `{}`", name.replace('`', "``"));
    if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(q_drop)).execute(pool).await {
        return json_fail(&format!("No se pudo eliminar: {e}"));
    }

    let username = mysql_username_for_db(&name);
    let q_drop_user = format!("DROP USER IF EXISTS '{}'@'%'", username.replace('\'', "''"));
    if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(q_drop_user))
        .execute(pool)
        .await
    {
        return json_fail(&format!(
            "Base de datos eliminada, pero no se pudo eliminar el usuario MySQL '{username}': {e}"
        ));
    }

    json_ok(json!({}))
}

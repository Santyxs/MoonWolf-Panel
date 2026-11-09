use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use mysql_async::prelude::*;
use mysql_async::{Opts, Pool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};
use tower_http::cors::{Any, CorsLayer};
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
    uploads: Arc<Mutex<HashMap<String, Arc<Mutex<UploadManifest>>>>>,
    backup_progress: Arc<Mutex<BackupProgress>>,
    backup_operation: Arc<Mutex<Option<String>>>,
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
        uploads: Arc::new(Mutex::new(HashMap::new())),
        backup_progress: Arc::new(Mutex::new(BackupProgress::default())),
        backup_operation: Arc::new(Mutex::new(None)),
    };
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

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
        .with_state(state)
        .layer(cors);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    info!("API local en {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router).await?;
    Ok(())
}

pub async fn wait_ready(port: u16, max_attempts: u32) -> anyhow::Result<()> {
    let url = format!("http://127.0.0.1:{port}/api/health");
    let client = http_client();
    for attempt in 1..=max_attempts {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        sleep_ms((250 * attempt).min(1500) as u64).await;
    }
    anyhow::bail!("El servidor local de MoonWolf no respondió a tiempo")
}

/* ══════════════════════════════════════════════
HELPERS GENERALES
══════════════════════════════════════════════ */

fn check_auth(headers: &HeaderMap, expected: &str) -> Result<(), StatusCode> {
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
    if token == expected || alt == expected || expected.is_empty() {
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
    let rel = rel.trim_start_matches(['/', '\\']);
    let joined = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "No se puede acceder a serverDir".to_string())?;
    if joined.exists() {
        let c = joined
            .canonicalize()
            .map_err(|_| "Ruta no permitida".to_string())?;
        if !c.starts_with(&canonical_root) {
            return Err("Ruta no permitida".into());
        }
        Ok(c)
    } else {
        let parent = joined.parent().unwrap_or(root);
        let parent_c = parent
            .canonicalize()
            .unwrap_or_else(|_| canonical_root.clone());
        if !parent_c.starts_with(&canonical_root) {
            return Err("Ruta no permitida".into());
        }
        Ok(joined)
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

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("create: {e}"))?;

    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("chunk: {e}"))? {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write: {e}"))?;
    }
    file.flush().await.ok();
    Ok(())
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

async fn get_file_content(
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
        Err(e) => return Ok(json_fail(&e)),
    };
    if !path.is_file() {
        return Ok(json_fail("No se puede leer el archivo"));
    }
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => Ok(json_ok(json!({
            "content": content,
            "filename": path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
        }))),
        Err(_) => Ok(json_fail("No se puede leer el archivo")),
    }
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
    let data = tokio::fs::read(&path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file.bin".into());
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/octet-stream")
        .header(
            "content-disposition",
            format!("attachment; filename=\"{name}\""),
        )
        .body(axum::body::Body::from(data))
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
        .chain(body.path.into_iter())
        .collect();

    for rel in paths {
        if let Ok(p) = resolve_safe(&root, &rel).await {
            if p.is_dir() {
                let _ = tokio::fs::remove_dir_all(&p).await;
            } else {
                let _ = tokio::fs::remove_file(&p).await;
            }
        }
    }
    Ok(json_ok(json!({})))
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

    if q.upload_id.len() < 8 || q.upload_id.len() > 120 {
        return Ok(json_fail("Identificador de subida no válido"));
    }
    if q.path.trim().is_empty() {
        return Ok(json_fail("Ruta requerida"));
    }
    if body.len() > UPLOAD_MAX_CHUNK {
        return Ok(json_fail("Bloque demasiado grande"));
    }
    if q.offset + body.len() as u64 > q.total_size {
        return Ok(json_fail("El bloque excede el tamaño indicado"));
    }

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
        if let Some(prev) = load_manifest(&root.join(UPLOAD_DIR_NAME), &q.upload_id).await {
            if prev.path == q.path && prev.total_size == q.total_size {
                *manifest = prev;
            }
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

        let chunk_end = q.offset + body.len() as u64;
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
        if let Some(last) = merged.last_mut() {
            if c.offset <= last.end {
                last.end = last.end.max(c.end);
                continue;
            }
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

async fn compute_total_bytes(root: &Path) -> u64 {
    let root_clone = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut total = 0u64;
        for entry in WalkDir::new(&root_clone).into_iter().filter_map(|e| e.ok()) {
            let rel = match entry.path().strip_prefix(&root_clone) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let first = rel
                .components()
                .next()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .unwrap_or_default();
            if backup_excluded(&first) {
                continue;
            }
            if entry.file_type().is_file() {
                if let Ok(meta) = entry.metadata() {
                    total += meta.len();
                }
            }
        }
        total
    })
    .await
    .unwrap_or(0)
}

async fn get_backup_progress(State(st): State<LocalState>) -> Response {
    let p = st.backup_progress.lock().await.clone();
    json_ok(json!({ "progress": p }))
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
            p.total_bytes = compute_total_bytes(&root).await;
            p.percent = 0;
            p.started_at = Some(crate::now_ms());
            p.error = None;
        }

        let server_running = st.mc.read().await.is_some();
        if server_running {
            let mut mc = st.mc.write().await;
            if let Some(child) = mc.as_mut() {
                if let Some(stdin) = child.stdin.as_mut() {
                    use tokio::io::AsyncWriteExt;
                    let _ = stdin.write_all(b"save-off\n").await;
                    let _ = stdin.write_all(b"save-all flush\n").await;
                }
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
            let file = std::fs::File::create(&zip_path_clone)?;
            let mut zip = ZipWriter::new(file);
            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .compression_level(Some(6));

            let mut processed = 0u64;

            for entry in WalkDir::new(&root_clone).into_iter().filter_map(|e| e.ok()) {
                let rel = match entry.path().strip_prefix(&root_clone) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let first = rel
                    .components()
                    .next()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .unwrap_or_default();
                if backup_excluded(&first) {
                    continue;
                }
                if entry.path() == root_clone {
                    continue;
                }

                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if entry.file_type().is_dir() {
                    zip.add_directory(&rel_str, options)?;
                } else if entry.file_type().is_file() {
                    zip.start_file(&rel_str, options)?;
                    let mut f = std::fs::File::open(entry.path())?;
                    std::io::copy(&mut f, &mut zip)?;
                    if let Ok(meta) = entry.metadata() {
                        processed += meta.len();
                        if let Ok(mut guard) = progress_ref.try_lock() {
                            guard.processed_bytes = processed;
                            if guard.total_bytes > 0 {
                                let pct = (processed * 100 / guard.total_bytes).min(99);
                                guard.percent = pct as u32;
                            }
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
            if let Some(child) = mc.as_mut() {
                if let Some(stdin) = child.stdin.as_mut() {
                    use tokio::io::AsyncWriteExt;
                    let _ = stdin.write_all(b"save-on\n").await;
                }
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
                if let Ok(meta) = ent.metadata().await {
                    if let Ok(modified) = meta.modified() {
                        files.push((name, modified));
                    }
                }
            }
            files.sort_by(|a, b| b.1.cmp(&a.1));
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

    let data = tokio::fs::read(&path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/zip")
        .header(
            "content-disposition",
            format!("attachment; filename=\"{name}\""),
        )
        .body(axum::body::Body::from(data))
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

    let was_running = {
        let mc = st.mc.write().await;
        mc.is_some()
    };
    if was_running {
        let mut mc = st.mc.write().await;
        if let Some(child) = mc.as_mut() {
            if let Some(stdin) = child.stdin.as_mut() {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(b"stop\n").await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill().await;
            }
            *mc = None;
        }
        {
            let mut s = st.app.write().await;
            s.mc_running = false;
        }
    }

    let root_clone = root.clone();
    let zip_path_clone = zip_path.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let file = std::fs::File::open(&zip_path_clone)?;
        let mut archive = zip::ZipArchive::new(file)?;

        for entry in std::fs::read_dir(&root_clone)? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            if backup_excluded(&name) {
                continue;
            }
            let p = entry.path();
            if entry.file_type()?.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            } else {
                let _ = std::fs::remove_file(&p);
            }
        }

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

            let target = root_clone.join(&rel);
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
            Ok(json_ok(
                json!({ "restored": true, "wasRunning": was_running }),
            ))
        }
        Ok(Err(e)) => Ok(json_fail(&format!("No se pudo restaurar: {e}"))),
        Err(e) => Ok(json_fail(&format!("Tarea restauración falló: {e}"))),
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
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<StartupConfig>(&raw) {
            return cfg;
        }
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

    let cfg = load_startup_config(&root).await;
    let jars = list_jars(&root).await;

    let props = read_properties(&root.join("server.properties")).await;
    let server_port: Option<u16> = props.get("server-port").and_then(|v| v.parse::<u16>().ok());

    Ok(json_ok(json!({
        "config": cfg,
        "jars": jars,
        "serverPort": server_port,
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
    if let Some(v) = body.extra_args {
        cfg.extra_args = v;
    }
    if let Some(v) = body.stop_command {
        if !v.is_empty() {
            cfg.stop_command = v;
        }
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

    let version = detect_version_from_name(&jar);
    let source = if version.is_some() {
        "jar-name"
    } else {
        "none"
    };
    let version_str = version.unwrap_or_default();
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

fn detect_version_from_name(jar_name: &str) -> Option<String> {
    let lower = jar_name.to_lowercase();
    let parts: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .filter(|s| !s.is_empty())
        .collect();

    for part in parts {
        if part.starts_with("1.") {
            let segments: Vec<&str> = part.split('.').collect();
            if segments.len() >= 2 {
                if let Ok(minor) = segments[1].parse::<u32>() {
                    if (7..=40).contains(&minor) {
                        return Some(part.to_string());
                    }
                }
            }
        }
        if part.len() >= 2 && part.contains('.') {
            if let Some(first) = part.split('.').next() {
                if let Ok(major) = first.parse::<u32>() {
                    if (20..=40).contains(&major) {
                        return Some(part.to_string());
                    }
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
    let existing = match tokio::fs::read_to_string(path).await {
        Ok(s) => s,
        Err(_) => String::new(),
    };

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

    if let Some(pw) = body.rcon_password {
        if !pw.is_empty() {
            props.insert("rcon.password".into(), pw);
        }
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

async fn server_status(State(st): State<LocalState>) -> Response {
    let running = {
        let mut mc = st.mc.write().await;
        if let Some(child) = mc.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *mc = None;
                    false
                }
                Ok(None) => true,
                Err(_) => {
                    *mc = None;
                    false
                }
            }
        } else {
            false
        }
    };
    {
        let mut s = st.app.write().await;
        s.mc_running = running;
    }
    json_ok(json!({
        "status": if running { "online" } else { "offline" },
        "running": running,
    }))
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

async fn start_server(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    let java_configured = s.config.java_path.clone();
    drop(s);

    {
        let mut mc = st.mc.write().await;
        if let Some(child) = mc.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *mc = None;
                }
                Ok(None) => return Ok(json_fail("El servidor ya está en ejecución")),
                Err(_) => {
                    *mc = None;
                }
            }
        }
    }

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

    let (java_bin, java_source) =
        tokio::task::spawn_blocking(move || resolve_java_binary(&java_configured))
            .await
            .map_err(|e| {
                tracing::error!("Detección de Java falló: {e}");
                StatusCode::INTERNAL_SERVER_ERROR
            })?;
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
    let max_mem = if cfg.max_memory_mb >= min_mem {
        cfg.max_memory_mb
    } else {
        2048
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

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!(
                "No se pudo arrancar Java desde {} ({}): {e}",
                java_bin.display(),
                java_source
            );
            let mut s = st.app.write().await;
            s.add_console_log("error", msg.clone());
            return Ok(json_fail(&msg));
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    *st.mc.write().await = Some(child);
    {
        let mut s = st.app.write().await;
        s.mc_running = true;
        s.add_console_log(
            "info",
            format!("Servidor Minecraft arrancado ({})", jar.display()),
        );
    }

    if let Some(stdout) = stdout {
        let app = Arc::clone(&st.app);
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut s = app.write().await;
                s.add_console_log("info", line);
            }
        });
    }

    if let Some(stderr) = stderr {
        let app = Arc::clone(&st.app);
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut s = app.write().await;
                s.add_console_log("error", line);
            }
        });
    }

    {
        let mc = Arc::clone(&st.mc);
        let app = Arc::clone(&st.app);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                let mut lock = mc.write().await;
                let Some(child) = lock.as_mut() else { break };
                match child.try_wait() {
                    Ok(Some(status)) => {
                        *lock = None;
                        drop(lock);
                        let mut s = app.write().await;
                        s.mc_running = false;
                        s.add_console_log(
                            "warn",
                            format!("Servidor Minecraft terminó (código {:?})", status.code()),
                        );
                        break;
                    }
                    Ok(None) => drop(lock),
                    Err(_) => {
                        *lock = None;
                        drop(lock);
                        let mut s = app.write().await;
                        s.mc_running = false;
                        s.add_console_log("warn", "No se pudo comprobar el estado del servidor");
                        break;
                    }
                }
            }
        });
    }

    Ok(json_ok(json!({})))
}

async fn stop_server(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    let stop_cmd = load_startup_config(&root).await.stop_command;

    let mut mc = st.mc.write().await;
    let Some(child) = mc.as_mut() else {
        return Ok(json_fail("El servidor no está corriendo"));
    };

    if let Some(stdin) = child.stdin.as_mut() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(format!("{}\n", stop_cmd).as_bytes()).await;
    }

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    match child.try_wait() {
        Ok(Some(_)) => {
            *mc = None;
        }
        _ => {
            let _ = child.kill().await;
            *mc = None;
        }
    }

    {
        let mut s = st.app.write().await;
        s.mc_running = false;
        s.add_console_log("info", "Servidor detenido");
    }
    Ok(json_ok(json!({})))
}

async fn restart_server(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let _ = stop_server(State(st.clone()), headers.clone()).await;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    start_server(State(st), headers).await
}

#[derive(Deserialize)]
struct CmdBody {
    cmd: String,
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
    if let Some(stdin) = child.stdin.as_mut() {
        use tokio::io::AsyncWriteExt;
        if stdin
            .write_all(format!("{cmd}\n").as_bytes())
            .await
            .is_err()
        {
            return Ok(json_fail("No se pudo enviar el comando"));
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
            { "id": "fabric", "label": "Fabric", "category": "mods", "desc": "Loader ligero para mods." },
            { "id": "velocity", "label": "Velocity", "category": "proxy", "desc": "Proxy moderno." },
            { "id": "waterfall", "label": "Waterfall", "category": "proxy", "desc": "Proxy basado en BungeeCord." },
            { "id": "forge", "label": "Forge", "category": "mods", "desc": "Loader clásico para mods." },
            { "id": "neoforge", "label": "NeoForge", "category": "mods", "desc": "Loader moderno para mods." },
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
        "fabric" => list_fabric_versions().await,
        "vanilla" => list_vanilla_versions().await,
        "forge" => list_forge_versions().await,
        "neoforge" => list_neoforge_versions().await,
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
        "fabric" => builds_fabric(&version).await,
        "vanilla" => builds_vanilla(&version).await,
        "forge" => builds_forge(&version).await,
        "neoforge" => builds_neoforge(&version).await,
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
        if !inst_path.exists() {
            if let Err(e) = download_to(&inst_url, &inst_path).await {
                return json_fail(&format!("Descarga installer falló: {e}"));
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
        if !inst_path.exists() {
            if let Err(e) = download_to(&url, &inst_path).await {
                return json_fail(&format!("Descarga installer falló: {e}"));
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

    let temp = server_dir.join(format!(".moonwolf-server-download-{}", std::process::id()));
    if let Err(e) = download_to(&url, &temp).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return json_fail(&format!("Descarga falló: {e}"));
    }

    let current = server_dir.join("server.jar");
    let backup = server_dir.join(format!("server.bak_{}.jar", crate::now_secs()));

    if current.exists() {
        let _ = tokio::fs::rename(&current, &backup).await;
    }
    if let Err(e) = tokio::fs::rename(&temp, &current).await {
        if backup.exists() {
            let _ = tokio::fs::rename(&backup, &current).await;
        }
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

    if source == "all" || source == "modrinth" {
        if let Err(e) = search_modrinth(&q_enc, &mut results).await {
            errors.push(format!("Modrinth: {e}"));
        }
    }
    if source == "all" || source == "spigot" {
        if let Err(e) = search_spiget(&q_enc, &mut results).await {
            errors.push(format!("SpigotMC: {e}"));
        }
    }
    if source == "all" || source == "hangar" {
        if let Err(e) = search_hangar(&q_enc, &mut results).await {
            errors.push(format!("Hangar: {e}"));
        }
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

async fn plugins_installed(State(st): State<LocalState>) -> Response {
    let server_dir = {
        let s = st.app.read().await;
        s.config.server_dir.clone()
    };
    let dir = plugins_dir(&server_dir);
    if !dir.exists() {
        return json_ok(json!({ "plugins": [] }));
    }

    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(r) => r,
        Err(_) => return json_ok(json!({ "plugins": [] })),
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

    json_ok(json!({ "plugins": plugins }))
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

static MYSQL_POOL: OnceLock<Pool> = OnceLock::new();

fn mysql_pool() -> &'static Pool {
    let host = std::env::var("MOONWOLF_MYSQL_HOST").unwrap_or_else(|_| "localhost".into());
    let port = std::env::var("MOONWOLF_MYSQL_PORT").unwrap_or_else(|_| "3306".into());
    let user = std::env::var("MOONWOLF_MYSQL_USER").unwrap_or_else(|_| "root".into());
    let password = std::env::var("MOONWOLF_MYSQL_PASSWORD").unwrap_or_default();

    MYSQL_POOL.get_or_init(|| {
        let url = format!(
            "mysql://{}:{}@{}:{}/?pool_min=0&pool_max=8&conn_ttl=1800&tcp_keepalive=30000&stmt_cache_size=32",
            urlencode(&user),
            urlencode(&password),
            host,
            port
        );
        let opts = Opts::from_url(&url).unwrap_or_else(|_| Opts::default());
        Pool::new(opts)
    })
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

fn gen_db_password() -> String {
    let mut bytes = [0u8; 18];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    crate::b64_std_encode(&bytes)
        .replace(['+', '/', '='], "")
        .chars()
        .take(20)
        .collect()
}

async fn db_status() -> Response {
    let host = std::env::var("MOONWOLF_MYSQL_HOST").unwrap_or_else(|_| "localhost".into());
    let port = std::env::var("MOONWOLF_MYSQL_PORT").unwrap_or_else(|_| "3306".into());

    let pool = mysql_pool();
    match pool.get_conn().await {
        Ok(mut conn) => {
            let ok_row: Result<Option<i32>, _> = conn.query_first("SELECT 1").await;
            match ok_row {
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
            }
        }
        Err(e) => json_ok(json!({
            "connected": false,
            "error": e.to_string(),
            "host": host,
            "port": port,
        })),
    }
}

async fn db_list() -> Response {
    let pool = mysql_pool();
    let mut conn = match pool.get_conn().await {
        Ok(c) => c,
        Err(e) => return json_fail(&format!("MySQL: {e}")),
    };

    let query = "SELECT s.SCHEMA_NAME AS name, \
        COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS sizeBytes, \
        COUNT(t.TABLE_NAME) AS tableCount \
        FROM information_schema.SCHEMATA s \
        LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME \
        WHERE s.SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') \
        GROUP BY s.SCHEMA_NAME ORDER BY s.SCHEMA_NAME";

    let result: Result<Vec<mysql_async::Row>, _> = conn.query(query).await;
    let rows = match result {
        Ok(r) => r,
        Err(e) => return json_fail(&format!("MySQL: {e}")),
    };

    let users: HashMap<String, String> = match conn.query("SELECT user FROM mysql.user").await {
        Ok(rows) => rows
            .into_iter()
            .filter_map(|row: mysql_async::Row| {
                let user: String = row.get("user")?;
                Some((user.clone(), user))
            })
            .collect(),
        Err(_) => HashMap::new(),
    };

    let mut databases = Vec::new();
    for row in rows {
        let name: String = row.get("name").unwrap_or_default();
        let size_bytes: u64 = row.get::<u64, _>("sizeBytes").unwrap_or(0);
        let tables: u64 = row.get::<u64, _>("tableCount").unwrap_or(0);

        let username: String = name.chars().take(32).collect();
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

    let pool = mysql_pool();
    let mut conn = match pool.get_conn().await {
        Ok(c) => c,
        Err(e) => return json_fail(&format!("MySQL: {e}")),
    };

    let exists: Option<String> = conn
        .exec_first(
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
            (&name,),
        )
        .await
        .ok()
        .flatten();
    if exists.is_some() {
        return json_fail("Ya existe una base de datos con ese nombre.");
    }

    if let Err(e) = conn
        .query_drop(format!(
            "CREATE DATABASE `{}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
            name.replace('`', "``")
        ))
        .await
    {
        return json_fail(&format!("No se pudo crear: {e}"));
    }

    let mut credentials = None;

    if create_user {
        let username = name.chars().take(32).collect::<String>();
        let password = gen_db_password();

        let q_user = format!(
            "CREATE USER IF NOT EXISTS '{}'@'%' IDENTIFIED BY '{}'",
            username.replace('\'', "''"),
            password.replace('\'', "''")
        );
        let _ = conn.query_drop(&q_user).await;

        let q_alter = format!(
            "ALTER USER '{}'@'%' IDENTIFIED BY '{}'",
            username.replace('\'', "''"),
            password.replace('\'', "''")
        );
        let _ = conn.query_drop(&q_alter).await;

        let q_grant = format!(
            "GRANT ALL PRIVILEGES ON `{}`.* TO '{}'@'%'",
            name.replace('`', "``"),
            username.replace('\'', "''")
        );
        let _ = conn.query_drop(&q_grant).await;

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

    let pool = mysql_pool();
    let mut conn = match pool.get_conn().await {
        Ok(c) => c,
        Err(e) => return json_fail(&format!("MySQL: {e}")),
    };

    let username: String = name.chars().take(32).collect();
    let exists: Option<String> = conn
        .exec_first("SELECT user FROM mysql.user WHERE user = ?", (&username,))
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
    let _ = conn.query_drop(&q_alter).await;

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

    let pool = mysql_pool();
    let mut conn = match pool.get_conn().await {
        Ok(c) => c,
        Err(e) => return json_fail(&format!("MySQL: {e}")),
    };

    let q_drop = format!("DROP DATABASE `{}`", name.replace('`', "``"));
    if let Err(e) = conn.query_drop(&q_drop).await {
        return json_fail(&format!("No se pudo eliminar: {e}"));
    }

    let username: String = name.chars().take(32).collect();
    let q_drop_user = format!("DROP USER IF EXISTS '{}'@'%'", username.replace('\'', "''"));
    let _ = conn.query_drop(&q_drop_user).await;

    json_ok(json!({}))
}

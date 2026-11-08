use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::{sleep_ms, AppState};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const UPLOAD_DIR_NAME: &str = ".moonwolf-uploads";
const UPLOAD_MAX_CHUNK: usize = 17 * 1024 * 1024;
const UPLOAD_BODY_LIMIT: usize = 20 * 1024 * 1024;

/* ══════════════════════════════════════════════
   ESTADO LOCAL
   ══════════════════════════════════════════════ */

#[derive(Clone)]
struct LocalState {
    app: Arc<RwLock<AppState>>,
    mc: Arc<RwLock<Option<Child>>>,
    uploads: Arc<Mutex<HashMap<String, Arc<Mutex<UploadManifest>>>>>,
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

pub async fn serve(app: Arc<RwLock<AppState>>, port: u16) -> anyhow::Result<()> {
    let state = LocalState {
        app,
        mc: Arc::new(RwLock::new(None)),
        uploads: Arc::new(Mutex::new(HashMap::new())),
    };
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/files", get(list_files))
        .route("/api/files/content", get(get_file_content).post(put_file_content))
        .route("/api/files/download", get(download_file))
        .route("/api/files/delete", post(delete_files))
        .route("/api/files/create", post(create_file))
        .route("/api/files/upload-chunk", post(upload_chunk))
        .route("/api/files/rename", post(rename_file))
        .route("/api/files/copy", post(copy_file))
        .route("/api/files/move", post(move_file))
        .route("/api/files/compress", post(compress_file))
        .route("/api/files/bulk", post(bulk_action))
        .route("/api/start", post(start_server))
        .route("/api/stop", post(stop_server))
        .route("/api/restart", post(restart_server))
        .route("/api/command", post(send_command))
        .route("/api/status", get(server_status))
        .route("/api/agent/state", get(agent_state))
        .route("/api/agent/logs/clear", post(clear_logs))
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
    for attempt in 1..=max_attempts {
        if let Ok(resp) = reqwest::get(&url).await {
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

fn resolve_safe(root: &Path, rel: &str) -> Result<PathBuf, String> {
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
        let parent_c = parent.canonicalize().unwrap_or_else(|_| canonical_root.clone());
        if !parent_c.starts_with(&canonical_root) {
            return Err("Ruta no permitida".into());
        }
        Ok(joined)
    }
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
   ARCHIVOS — listado, lectura, escritura
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

    if !root.exists() {
        let _ = tokio::fs::create_dir_all(&root).await;
    }

    let rel = q.dir.or(q.path).unwrap_or_default();
    let dir = match resolve_safe(&root, &rel) {
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
            .map(|d| {
                let secs = d.as_secs() as i64;
                chrono::DateTime::from_timestamp(secs, 0)
                    .map(|dt| dt.format("%d/%m/%Y, %H:%M:%S").to_string())
                    .unwrap_or_default()
            })
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
    let path = match resolve_safe(&root, &rel) {
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

    let path = match resolve_safe(&root, &body.path) {
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
    let path = match resolve_safe(&root, &rel) {
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
        if let Ok(p) = resolve_safe(&root, &rel) {
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

    let path = match resolve_safe(&root, &body.path) {
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

    let full = match resolve_safe(&root, &q.path) {
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
        return Ok(json_fail(&format!("No se pudo crear carpeta temporal: {e}")));
    }

    let part_path = upload_dir.join(format!("{}.part", q.upload_id));

    if !body.is_empty() {
        use tokio::io::{AsyncSeekExt, AsyncWriteExt};

        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&part_path)
            .await;
        let mut file = match file {
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

    if let Ok(f) = tokio::fs::OpenOptions::new().write(true).open(&part_path).await {
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

    if body.new_name.contains('/') || body.new_name.contains('\\') || body.new_name.contains("..")
    {
        return Ok(json_fail("Nombre no válido"));
    }

    let from = match resolve_safe(&root, &body.path) {
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
    let to = match resolve_safe(&root, &target_rel) {
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

    let src = match resolve_safe(&root, &body.path) {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    let dst = match resolve_safe(&root, &body.dest) {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    if let Some(parent) = dst.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    let src_clone = src.clone();
    let dst_clone = dst.clone();
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<u64> {
        if src_clone.is_dir() {
            // Copia recursiva
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
            Ok(0)
        } else {
            if let Some(p) = dst_clone.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::copy(&src_clone, &dst_clone)
        }
    })
    .await;

    match result {
        Ok(Ok(_)) => Ok(json_ok(json!({}))),
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

    let src = match resolve_safe(&root, &body.path) {
        Ok(p) => p,
        Err(e) => return Ok(json_fail(&e)),
    };
    let dst = match resolve_safe(&root, &body.dest) {
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

    let src = match resolve_safe(&root, &body.path) {
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
    #[serde(default, rename = "isDir")]
    is_dir: bool,
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
                        format!(
                            "{}/{}",
                            body.destination.trim_end_matches('/'),
                            name
                        )
                    };
                    let dst = resolve_safe(&root, &target_rel)
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
                            for entry in
                                WalkDir::new(&src).into_iter().filter_map(|e| e.ok())
                            {
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
                results.push(json!({
                    "path": item.path,
                    "ok": false,
                    "error": e.to_string(),
                }));
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
   SERVIDOR MINECRAFT
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

async fn find_server_jar(dir: &Path) -> Option<PathBuf> {
    let mut rd = tokio::fs::read_dir(dir).await.ok()?;
    let mut jars = Vec::new();
    while let Ok(Some(ent)) = rd.next_entry().await {
        let name = ent.file_name().to_string_lossy().to_string();
        if name.to_lowercase().ends_with(".jar") && !name.to_lowercase().contains("installer") {
            jars.push(ent.path());
        }
    }
    jars.sort();
    jars.into_iter().next()
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
        let major = match name.strip_prefix("java").and_then(|s| s.parse::<u32>().ok()) {
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
    drop(s);

    {
        let mut mc = st.mc.write().await;
        if let Some(child) = mc.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *mc = None;
                }
                Ok(None) => {
                    return Ok(json_fail(
                        "El servidor ya está arrancando o en ejecución",
                    ));
                }
                Err(_) => {
                    *mc = None;
                }
            }
        }
    }

    if !root.exists() {
        let _ = tokio::fs::create_dir_all(&root).await;
    }

    let jar = match find_server_jar(&root).await {
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

    let (java_bin, java_source) = {
        let s = st.app.read().await;
        let configured = s.config.java_path.clone();
        drop(s);
        resolve_java_binary(&configured)
    };

    {
        let mut s = st.app.write().await;
        s.add_console_log(
            "info",
            format!(
                "Usando Java desde {} ({})",
                java_bin.display(),
                java_source
            ),
        );
    }

    let mut cmd = Command::new(&java_bin);
    cmd.current_dir(&root)
        .arg("-Xms1G")
        .arg("-Xmx2G")
        .arg("-jar")
        .arg(&jar)
        .arg("nogui")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let mut s = st.app.write().await;
            let msg = format!(
                "No se pudo arrancar Java desde {} ({}): {e}.",
                java_bin.display(),
                java_source
            );
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
                            format!(
                                "Servidor Minecraft terminó (código {:?})",
                                status.code()
                            ),
                        );
                        break;
                    }
                    Ok(None) => drop(lock),
                    Err(_) => {
                        *lock = None;
                        drop(lock);
                        let mut s = app.write().await;
                        s.mc_running = false;
                        s.add_console_log(
                            "warn",
                            "No se pudo comprobar el estado del servidor",
                        );
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
    drop(s);

    let mut mc = st.mc.write().await;
    let Some(child) = mc.as_mut() else {
        return Ok(json_fail("El servidor no está corriendo"));
    };

    if let Some(stdin) = child.stdin.as_mut() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(b"stop\n").await;
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
        if stdin.write_all(format!("{cmd}\n").as_bytes()).await.is_err() {
            return Ok(json_fail("No se pudo enviar el comando"));
        }
    }
    Ok(json_ok(json!({})))
}

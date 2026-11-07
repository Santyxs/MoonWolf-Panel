//! API HTTP local del Agent (Axum).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use crate::state::AppState;
use crate::util::sleep_ms;

const MAX_UPLOAD_BYTES: usize = 18 * 1024 * 1024;

#[derive(Clone)]
struct LocalState {
    app: Arc<RwLock<AppState>>,
}

pub async fn serve(app: Arc<RwLock<AppState>>, port: u16) -> anyhow::Result<()> {
    let state = LocalState { app };
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/files", get(list_files))
        .route("/api/files/content", get(get_file_content).post(put_file_content))
        .route("/api/files/download", get(download_file))
        .route("/api/agent/state", get(agent_state))
        .route("/api/agent/logs/clear", post(clear_logs))
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

fn check_auth(headers: &HeaderMap, expected: &str) -> Result<(), StatusCode> {
    let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("");
    let token = auth.strip_prefix("Bearer ").or_else(|| auth.strip_prefix("Token ")).unwrap_or(auth);
    let alt = headers.get("x-moonwolf-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    if token == expected || alt == expected || expected.is_empty() {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

async fn health(State(st): State<LocalState>) -> impl IntoResponse {
    let s = st.app.read().await;
    Json(serde_json::json!({
        "ok": true,
        "version": s.version,
        "agentId": s.config.agent_id,
        "localReady": s.local_ready,
        "cloudConnected": s.cloud_connected,
    }))
}

async fn agent_state(State(st): State<LocalState>, headers: HeaderMap) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    Ok(Json(s.snapshot()).into_response())
}

async fn clear_logs(State(st): State<LocalState>, headers: HeaderMap) -> Result<Response, StatusCode> {
    let mut s = st.app.write().await;
    check_auth(&headers, &s.config.local_token)?;
    s.logs.clear();
    s.add_log("info", "Registro de logs limpiado");
    Ok(Json(serde_json::json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
struct PathQuery { path: Option<String> }

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: Option<i64>,
}

fn resolve_safe(root: &Path, rel: &str) -> Result<PathBuf, StatusCode> {
    let rel = rel.trim_start_matches(['/', '\\']);
    let joined = root.join(rel);
    let canonical_root = root.canonicalize().map_err(|_| StatusCode::BAD_REQUEST)?;
    if joined.exists() {
        let to_check = joined.canonicalize().map_err(|_| StatusCode::BAD_REQUEST)?;
        if !to_check.starts_with(&canonical_root) {
            return Err(StatusCode::FORBIDDEN);
        }
        Ok(to_check)
    } else {
        let parent = joined.parent().unwrap_or(root);
        let parent_c = parent.canonicalize().unwrap_or_else(|_| canonical_root.clone());
        if !parent_c.starts_with(&canonical_root) {
            return Err(StatusCode::FORBIDDEN);
        }
        Ok(joined)
    }
}

async fn list_files(
    State(st): State<LocalState>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    if !root.exists() {
        let _ = tokio::fs::create_dir_all(&root).await;
    }
    let rel = q.path.unwrap_or_default();
    let dir = resolve_safe(&root, &rel)?;
    if !dir.is_dir() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut entries = Vec::new();
    let mut rd = tokio::fs::read_dir(&dir).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    while let Ok(Some(ent)) = rd.next_entry().await {
        let meta = ent.metadata().await.ok();
        let name = ent.file_name().to_string_lossy().to_string();
        let rel_path = Path::new(&rel).join(&name);
        entries.push(FileEntry {
            name,
            path: rel_path.to_string_lossy().replace('\\', "/"),
            is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            modified: meta.and_then(|m| m.modified().ok()).and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs() as i64)
            }),
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(Json(serde_json::json!({ "ok": true, "entries": entries })).into_response())
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
    let rel = q.path.ok_or(StatusCode::BAD_REQUEST)?;
    let path = resolve_safe(&root, &rel)?;
    if !path.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    let data = tokio::fs::read(&path).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if data.len() > MAX_UPLOAD_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    match String::from_utf8(data.clone()) {
        Ok(text) => Ok(Json(serde_json::json!({
            "ok": true, "encoding": "utf8", "content": text, "size": data.len(),
        })).into_response()),
        Err(_) => {
            use base64::{engine::general_purpose::STANDARD, Engine};
            Ok(Json(serde_json::json!({
                "ok": true, "encoding": "base64", "content": STANDARD.encode(&data), "size": data.len(),
            })).into_response())
        }
    }
}

#[derive(Deserialize)]
struct PutBody {
    path: String,
    content: String,
    #[serde(default)]
    encoding: String,
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
    let path = resolve_safe(&root, &body.path)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    let bytes = if body.encoding == "base64" {
        use base64::{engine::general_purpose::STANDARD, Engine};
        STANDARD.decode(body.content.trim()).map_err(|_| StatusCode::BAD_REQUEST)?
    } else {
        body.content.into_bytes()
    };
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    tokio::fs::write(&path, &bytes).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "ok": true, "size": bytes.len() })).into_response())
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
    let rel = q.path.ok_or(StatusCode::BAD_REQUEST)?;
    let path = resolve_safe(&root, &rel)?;
    if !path.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    let data = tokio::fs::read(&path).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file.bin".into());
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/octet-stream")
        .header("content-disposition", format!("attachment; filename=\"{name}\""))
        .body(axum::body::Body::from(data))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

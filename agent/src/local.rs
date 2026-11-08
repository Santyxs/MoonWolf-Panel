use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tokio::process::{Child, Command};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use crate::state::AppState;
use crate::util::sleep_ms;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone)]
struct LocalState {
    app: Arc<RwLock<AppState>>,
    mc: Arc<RwLock<Option<Child>>>,
}

pub async fn serve(app: Arc<RwLock<AppState>>, port: u16) -> anyhow::Result<()> {
    let state = LocalState {
        app,
        mc: Arc::new(RwLock::new(None)),
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
        .route("/api/start", post(start_server))
        .route("/api/stop", post(stop_server))
        .route("/api/restart", post(restart_server))
        .route("/api/command", post(send_command))
        .route("/api/status", get(server_status))
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
    s.logs.clear();
    s.add_log("info", "Registro de logs limpiado");
    Ok(json_ok(json!({})))
}

#[derive(Deserialize)]
struct DirQuery {
    dir: Option<String>,
    path: Option<String>,
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

    // Panel usa ?dir= ; nosotros también aceptamos ?path=
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

async fn start_server(
    State(st): State<LocalState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let s = st.app.read().await;
    check_auth(&headers, &s.config.local_token)?;
    let root = s.config.server_dir.clone();
    drop(s);

    // 1) Comprobar si el proceso sigue realmente vivo (no sólo is_some)
    {
        let mut mc = st.mc.write().await;
        if let Some(child) = mc.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    // ya terminó: limpiar y permitir arrancar de nuevo
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
            return Ok(json_fail(
                "No se encontró ningún .jar en la carpeta del servidor",
            ));
        }
    };

    let mut cmd = Command::new("java");
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

    // 2) En Windows: no abrir consola nueva
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Ok(json_fail(&format!(
                "No se pudo arrancar Java: {e}. ¿Está Java instalado y en el PATH?"
            )));
        }
    };

    // 3) Sacar stdout/stderr ANTES de guardar el child
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    *st.mc.write().await = Some(child);

    {
        let mut s = st.app.write().await;
        s.add_log(
            "info",
            format!("Servidor Minecraft arrancado ({})", jar.display()),
        );
    }

    // Tarea que lee stdout y lo vuelca a los logs
    if let Some(stdout) = stdout {
        let app = Arc::clone(&st.app);
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut s = app.write().await;
                s.add_log("info", line);
            }
        });
    }

    // Tarea que lee stderr y lo vuelca a los logs
    if let Some(stderr) = stderr {
        let app = Arc::clone(&st.app);
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut s = app.write().await;
                s.add_log("error", line);
            }
        });
    }

    // Tarea vigía: limpia `mc` cuando el proceso termina
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
                        s.add_log(
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
                        s.add_log(
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

    // Esperar un poco y forzar si hace falta
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
        s.add_log("info", "Servidor detenido");
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

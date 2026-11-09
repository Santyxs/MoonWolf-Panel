//! Cliente Socket.IO hacia MoonWolf Cloud.

use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::TimeZone;
use futures::future::FutureExt;
use rust_socketio::asynchronous::{Client, ClientBuilder};
use rust_socketio::{Event, Payload, TransportType};
use serde_json::json;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::{sleep_ms, AppState, LogEntry, LOCAL_PORT};

const RECONNECT_BASE_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;
const CONNECT_WAIT_MS: u64 = 20_000;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const HEALTHY_CONNECTION: Duration = Duration::from_secs(60);

pub async fn run(app: Arc<RwLock<AppState>>, panel_url: &str) {
    let mut backoff = RECONNECT_BASE_MS;
    let mut attempt: u32 = 0;

    loop {
        if app.read().await.shutting_down {
            break;
        }

        attempt += 1;
        let started = Instant::now();
        let result = connect_once(Arc::clone(&app), panel_url, attempt).await;
        let duration = started.elapsed();

        if app.read().await.shutting_down {
            break;
        }

        match &result {
            Ok(()) => {
                info!("Cloud: conexión cerrada tras {:?}", duration);
            }
            Err(e) => {
                error!("Cloud: {e:#}");
                let mut s = app.write().await;
                s.cloud_connected = false;
                s.pairing_code = None;
                s.add_log("error", humanize_cloud_error(&format!("{e}")));
            }
        }

        if duration >= HEALTHY_CONNECTION {
            backoff = RECONNECT_BASE_MS;
        } else {
            backoff = (backoff * 2).min(RECONNECT_MAX_MS);
        }

        info!("Reintento de Cloud en {backoff} ms…");
        {
            let mut s = app.write().await;
            s.add_log("warn", format!("Reconexión programada en {backoff} ms"));
        }
        sleep_ms(backoff).await;
    }
}

async fn connect_once(
    app: Arc<RwLock<AppState>>,
    panel_url: &str,
    attempt: u32,
) -> anyhow::Result<()> {
    let (agent_id, agent_token) = {
        let s = app.read().await;
        (s.config.agent_id.clone(), s.config.agent_token.clone())
    };

    if agent_id.len() < 16 || agent_token.len() < 32 {
        anyhow::bail!(
            "credenciales inválidas (agentId len={}, token len={})",
            agent_id.len(),
            agent_token.len()
        );
    }

    info!("Conectando a Cloud (intento #{attempt}): {panel_url} agentId={agent_id}");
    {
        let mut s = app.write().await;
        s.add_log(
            "info",
            format!("Conectando con MoonWolf Cloud (intento #{attempt})…"),
        );
    }

    let auth = json!({
        "role": "agent",
        "agentId": agent_id,
        "token": agent_token,
    });

    let app_on_connect = Arc::clone(&app);
    let app_on_close = Arc::clone(&app);
    let app_on_error = Arc::clone(&app);

    let client = ClientBuilder::new(panel_url)
        .namespace("/")
        .transport_type(TransportType::Any) // polling primero; upgrade a websocket si se puede
        .auth(auth)
        .on(Event::Connect, move |_, socket: Client| {
            let app = Arc::clone(&app_on_connect);
            async move {
                info!("Socket Cloud conectado");
                {
                    let mut s = app.write().await;
                    s.cloud_connected = true;
                    s.add_log("info", "Conectado a MoonWolf Cloud.");
                }
                if let Err(e) = socket.emit("pairing_create", json!({})).await {
                    error!("pairing_create: {e}");
                    let mut s = app.write().await;
                    s.add_log("error", format!("No se pudo pedir pairing: {e}"));
                } else {
                    let mut s = app.write().await;
                    s.add_log("info", "Solicitando código de emparejamiento…");
                }
            }
            .boxed()
        })
        .on(Event::Close, move |_, _| {
            let app = Arc::clone(&app_on_close);
            async move {
                let mut s = app.write().await;
                s.cloud_connected = false;
                s.pairing_code = None;
                s.add_log("warn", "Desconectado de MoonWolf Cloud");
            }
            .boxed()
        })
        .on("error", move |payload: Payload, _| {
            let app = Arc::clone(&app_on_error);
            async move {
                let msg = payload_debug(&payload);
                warn!("Cloud error event: {msg}");
                let mut s = app.write().await;
                s.cloud_connected = false;
                s.pairing_code = None;
                s.add_log("error", humanize_cloud_error(&msg));
            }
            .boxed()
        })
        .on("connect_error", {
            let app = Arc::clone(&app);
            move |payload: Payload, _| {
                let app = Arc::clone(&app);
                async move {
                    let msg = payload_debug(&payload);
                    error!("connect_error: {msg}");
                    let mut s = app.write().await;
                    s.cloud_connected = false;
                    s.pairing_code = None;
                    s.add_log("error", humanize_cloud_error(&format!("connect_error: {msg}")));
                }
                .boxed()
            }
        })
        .on("pairing_ready", {
            let app = Arc::clone(&app);
            move |payload: Payload, _| {
                let app = Arc::clone(&app);
                async move {
                    let data = payload_json(&payload);
                    let code = data
                        .get("code")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string();
                    if code.is_empty() || !code.starts_with("MW-P") {
                        let mut s = app.write().await;
                        s.add_log("error", format!("pairing_ready inválido: {data}"));
                        return;
                    }
                    let mut s = app.write().await;
                    s.pairing_code = Some(code.clone());
                    s.add_log("info", format!("Código de emparejamiento disponible: {code}"));
                }
                .boxed()
            }
        })
        .on("pairing_consumed", {
            let app = Arc::clone(&app);
            move |_, socket: Client| {
                let app = Arc::clone(&app);
                async move {
                    {
                        let mut s = app.write().await;
                        s.pairing_code = None;
                        s.add_log(
                            "info",
                            "Código de emparejamiento utilizado. Generando uno nuevo.",
                        );
                    }
                    let _ = socket.emit("pairing_create", json!({})).await;
                }
                .boxed()
            }
        })
        .on("rpc", {
            let app = Arc::clone(&app);
            move |payload: Payload, socket: Client| {
                let app = Arc::clone(&app);
                async move {
                    let result = handle_rpc(&app, &payload).await;
                    if let Err(e) = socket.emit("rpc_result", result).await {
                        warn!("rpc_result emit: {e}");
                    }
                }
                .boxed()
            }
        })
        .on_any({
            move |event, payload, _| {
                async move {
                    debug!(?event, "evento cloud: {}", payload_debug(&payload));
                }
                .boxed()
            }
        })
        .connect()
        .await
        .map_err(|e| anyhow::anyhow!("connect falló: {e}"))?;

    let wait_start = Instant::now();
    while !app.read().await.cloud_connected {
        if wait_start.elapsed() > Duration::from_millis(CONNECT_WAIT_MS) {
            let _ = client.disconnect().await;
            anyhow::bail!("timeout esperando handshake de Socket.IO");
        }
        sleep_ms(100).await;
    }

    let (initial_logs, mut last_console_seq) = {
        let s = app.read().await;
        let logs: Vec<_> = s.console_logs.iter().map(log_to_panel).collect();
        (logs, s.console_seq)
    };
    if !initial_logs.is_empty() {
        let _ = client
            .emit(
                "event",
                json!({
                    "name": "log_batch",
                    "payload": initial_logs,
                }),
            )
            .await;
    }

    let mut last_mc_running = app.read().await.mc_running;
    let mut last_heartbeat = Instant::now();
    let mut last_activity = Instant::now();

    loop {
        sleep_ms(500).await;

        let (shutting_down, connected, console_seq, mc_running) = {
            let s = app.read().await;
            (s.shutting_down, s.cloud_connected, s.console_seq, s.mc_running)
        };

        if shutting_down || !connected {
            break;
        }

        if console_seq > last_console_seq {
            let new_logs: Vec<_> = {
                let s = app.read().await;
                s.console_logs
                    .iter()
                    .filter(|l| l.seq > last_console_seq)
                    .map(log_to_panel)
                    .collect()
            };
            if !new_logs.is_empty() {
                let event_name = if new_logs.len() == 1 { "log" } else { "log_batch" };
                let payload = if new_logs.len() == 1 {
                    new_logs[0].clone()
                } else {
                    json!(new_logs)
                };
                if let Err(e) = client
                    .emit("event", json!({ "name": event_name, "payload": payload }))
                    .await
                {
                    warn!("emit log falló: {e}");
                    break;
                }
                last_activity = Instant::now();
            }
            last_console_seq = console_seq;
        }

        if mc_running != last_mc_running {
            let _ = client
                .emit(
                    "event",
                    json!({
                        "name": "status",
                        "payload": if mc_running { "online" } else { "offline" },
                    }),
                )
                .await;
            last_mc_running = mc_running;
            last_activity = Instant::now();
        }

        if last_heartbeat.elapsed() >= HEARTBEAT_INTERVAL {
            match client
                .emit(
                    "event",
                    json!({
                        "name": "status",
                        "payload": if mc_running { "online" } else { "offline" },
                    }),
                )
                .await
            {
                Ok(_) => {
                    last_heartbeat = Instant::now();
                    last_activity = Instant::now();
                }
                Err(e) => {
                    warn!("heartbeat falló: {e}");
                    break;
                }
            }
        }

        if last_activity.elapsed() >= IDLE_TIMEOUT {
            warn!("Sin actividad en 60 s; cerrando socket para reconectar");
            break;
        }
    }

    let _ = client.disconnect().await;
    Ok(())
}

fn log_to_panel(entry: &LogEntry) -> serde_json::Value {
    let time = entry
        .time
        .with_timezone(&chrono::Local)
        .format("%H:%M:%S")
        .to_string();
    let type_str = match entry.level.as_str() {
        "error" => "error",
        "warn" => "warn",
        _ => "info",
    };
    json!({
        "line": entry.message,
        "time": time,
        "type": type_str,
    })
}

fn payload_json(payload: &Payload) -> serde_json::Value {
    match payload {
        Payload::Text(values) => values.first().cloned().unwrap_or(json!({})),
        Payload::Binary(_) => json!({}),
        _ => json!({}),
    }
}

fn payload_debug(payload: &Payload) -> String {
    match payload {
        Payload::Text(values) => values
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(", "),
        Payload::Binary(b) => format!("<binary {} bytes>", b.len()),
        _ => format!("{payload:?}"),
    }
}


fn humanize_cloud_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("engineio") || lower.contains("engine.io") || lower.contains("incomplete response") {
        return "No se pudo establecer la conexión con Cloud (Engine.IO). El panel puede estar reiniciando o la red bloquea WebSocket; reintentando…".into();
    }
    if lower.contains("timeout") {
        return "Tiempo de espera agotado al conectar con Cloud. Reintentando…".into();
    }
    if lower.contains("connect_error") || lower.contains("unauthorized") || lower.contains("auth") {
        return format!("Cloud rechazó la conexión: {raw}");
    }
    raw.to_string()
}

async fn handle_rpc(app: &Arc<RwLock<AppState>>, payload: &Payload) -> serde_json::Value {
    let req = payload_json(payload);
    let method = req
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("GET")
        .to_uppercase();
    let path = req
        .get("path")
        .and_then(|p| p.as_str())
        .unwrap_or("/api/health");
    let id = req.get("id").cloned().unwrap_or(json!(null));

    let token = {
        let s = app.read().await;
        s.config.local_token.clone()
    };

    let url = format!("http://127.0.0.1:{}{}", LOCAL_PORT, path);
    let client = reqwest::Client::new();
    let mut builder = match method.as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        "PATCH" => client.patch(&url),
        _ => client.get(&url),
    };
    builder = builder
        .header("Authorization", format!("Bearer {token}"))
        .header("X-MoonWolf-Token", &token)
        .timeout(Duration::from_secs(120));

    if let Some(body) = req.get("body") {
        if !body.is_null() {
            builder = builder.json(body);
        }
    }

    match builder.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let ok = resp.status().is_success();
            let content_type = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/json")
                .to_string();
            let bytes = resp.bytes().await.unwrap_or_default();
            json!({
                "id": id,
                "ok": ok,
                "status": status,
                "contentType": content_type,
                "bodyBase64": B64.encode(&bytes),
            })
        }
        Err(e) => {
            let msg = e.to_string();
            let err_body = json!({ "ok": false, "error": msg });
            let bytes = serde_json::to_vec(&err_body).unwrap_or_default();
            json!({
                "id": id,
                "ok": false,
                "status": 502,
                "contentType": "application/json",
                "bodyBase64": B64.encode(&bytes),
            })
        }
    }
}

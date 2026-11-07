//! Cliente Socket.IO hacia MoonWolf Cloud.

use std::sync::Arc;
use std::time::Duration;

use futures::future::FutureExt;
use rust_socketio::asynchronous::{Client, ClientBuilder};
use rust_socketio::{Event, Payload, TransportType};
use serde_json::json;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::state::AppState;
use crate::util::sleep_ms;

const RECONNECT_BASE_MS: u64 = 2_000;
const RECONNECT_MAX_MS: u64 = 60_000;

pub async fn run(app: Arc<RwLock<AppState>>, panel_url: &str) {
    let mut backoff = RECONNECT_BASE_MS;
    loop {
        {
            let s = app.read().await;
            if s.shutting_down { break; }
        }
        match connect_once(Arc::clone(&app), panel_url).await {
            Ok(()) => { backoff = RECONNECT_BASE_MS; }
            Err(e) => {
                error!("Cloud: {e:#}");
                let mut s = app.write().await;
                s.cloud_connected = false;
                s.pairing_code = None;
                s.add_log("error", format!("Error de conexión con Cloud: {e}"));
            }
        }
        {
            let s = app.read().await;
            if s.shutting_down { break; }
        }
        info!("Reintento de Cloud en {backoff} ms…");
        sleep_ms(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_MAX_MS);
    }
}

async fn connect_once(app: Arc<RwLock<AppState>>, panel_url: &str) -> anyhow::Result<()> {
    let (agent_id, agent_token, version) = {
        let s = app.read().await;
        (s.config.agent_id.clone(), s.config.agent_token.clone(), s.version.clone())
    };
    info!("Conectando a Cloud: {panel_url}");

    let app_on_connect = Arc::clone(&app);
    let app_on_close = Arc::clone(&app);
    let agent_id_c = agent_id.clone();
    let agent_token_c = agent_token.clone();
    let version_c = version.clone();

    let client = ClientBuilder::new(panel_url)
        .transport_type(TransportType::Websocket)
        .namespace("/")
        .on(Event::Connect, move |_, socket: Client| {
            let app = Arc::clone(&app_on_connect);
            let agent_id = agent_id_c.clone();
            let agent_token = agent_token_c.clone();
            let version = version_c.clone();
            async move {
                info!("Socket Cloud conectado");
                {
                    let mut s = app.write().await;
                    s.cloud_connected = true;
                    s.add_log("info", "Conectado a MoonWolf Cloud");
                }
                let payload = json!({
                    "agentId": agent_id,
                    "agentToken": agent_token,
                    "version": version,
                    "platform": std::env::consts::OS,
                    "arch": std::env::consts::ARCH,
                });
                if let Err(e) = socket.emit("agent_register", payload).await {
                    error!("agent_register: {e}");
                }
            }.boxed()
        })
        .on(Event::Close, move |_, _| {
            let app = Arc::clone(&app_on_close);
            async move {
                let mut s = app.write().await;
                s.cloud_connected = false;
                s.pairing_code = None;
                s.add_log("warn", "Desconectado de MoonWolf Cloud");
            }.boxed()
        })
        .on("pairing_code", {
            let app = Arc::clone(&app);
            move |payload: Payload, _| {
                let app = Arc::clone(&app);
                async move {
                    if let Some(code) = payload_string(&payload) {
                        let mut s = app.write().await;
                        s.pairing_code = Some(code.clone());
                        s.add_log("info", format!("Código de emparejamiento: {code}"));
                    }
                }.boxed()
            }
        })
        .on("paired", {
            let app = Arc::clone(&app);
            move |payload: Payload, _| {
                let app = Arc::clone(&app);
                async move {
                    let mut s = app.write().await;
                    s.pairing_code = None;
                    s.add_log("info", format!("Código de emparejamiento utilizado ({})", payload_string(&payload).unwrap_or_default()));
                }.boxed()
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
                }.boxed()
            }
        })
        .on_any({
            move |event, payload, _| {
                async move {
                    debug!(?event, "evento cloud: {:?}", payload_string(&payload));
                }.boxed()
            }
        })
        .connect()
        .await
        .map_err(|e| anyhow::anyhow!("connect: {e}"))?;

    loop {
        sleep_ms(1_000).await;
        let s = app.read().await;
        if s.shutting_down || !s.cloud_connected { break; }
    }
    let _ = client.disconnect().await;
    Ok(())
}

fn payload_string(payload: &Payload) -> Option<String> {
    match payload {
        Payload::Text(values) => values.first().and_then(|v| {
            v.as_str().map(|s| s.to_string())
                .or_else(|| v.get("code").and_then(|c| c.as_str()).map(|s| s.to_string()))
                .or_else(|| Some(v.to_string()))
        }),
        Payload::Binary(_) => None,
        _ => None,
    }
}

async fn handle_rpc(app: &Arc<RwLock<AppState>>, payload: &Payload) -> serde_json::Value {
    let req = match payload {
        Payload::Text(values) => values.first().cloned().unwrap_or(json!({})),
        _ => json!({}),
    };
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("GET").to_uppercase();
    let path = req.get("path").and_then(|p| p.as_str()).unwrap_or("/api/health");
    let id = req.get("id").cloned().unwrap_or(json!(null));
    let token = { let s = app.read().await; s.config.local_token.clone() };
    let url = format!("http://127.0.0.1:10000{path}");
    let client = reqwest::Client::new();
    let mut builder = match method.as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };
    builder = builder.header("Authorization", format!("Bearer {token}")).timeout(Duration::from_secs(120));
    if let Some(body) = req.get("body") {
        builder = builder.json(body);
    }
    match builder.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
            let bytes = resp.bytes().await.unwrap_or_default();
            let body_json: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));
            json!({ "id": id, "ok": status < 400, "status": status, "contentType": content_type, "body": body_json })
        }
        Err(e) => json!({ "id": id, "ok": false, "status": 502, "error": e.to_string() }),
    }
}

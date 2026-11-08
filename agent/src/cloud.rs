//! Cliente Socket.IO hacia MoonWolf Cloud.

use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures::future::FutureExt;
use rust_socketio::asynchronous::{Client, ClientBuilder};
use rust_socketio::{Event, Payload, TransportType};
use serde_json::json;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::{sleep_ms, AppState};

const RECONNECT_BASE_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;

pub async fn run(app: Arc<RwLock<AppState>>, panel_url: &str) {
    let mut backoff = RECONNECT_BASE_MS;
    let mut attempt: u32 = 0;

    loop {
        {
            let s = app.read().await;
            if s.shutting_down {
                break;
            }
        }

        attempt += 1;
        match connect_once(Arc::clone(&app), panel_url, attempt).await {
            Ok(()) => {
                backoff = RECONNECT_BASE_MS;
            }
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
            if s.shutting_down {
                break;
            }
        }

        info!("Reintento de Cloud en {backoff} ms…");
        {
            let mut s = app.write().await;
            s.add_log("warn", format!("Reconexión programada en {backoff} ms"));
        }
        sleep_ms(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_MAX_MS);
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
        .transport_type(TransportType::WebsocketUpgrade)
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
                s.add_log("error", format!("Error Cloud: {msg}"));
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
                    s.add_log("error", format!("connect_error: {msg}"));
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

    loop {
        sleep_ms(1_000).await;
        let s = app.read().await;
        if s.shutting_down || !s.cloud_connected {
            break;
        }
    }

    let _ = client.disconnect().await;
    Ok(())
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

/// Igual que forwardHttp del agent Node: bodyBase64 + contentType + status.
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

    // path puede incluir query: /api/files?dir=
    let url = format!("http://127.0.0.1:10000{path}");
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

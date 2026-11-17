//! Cliente Socket.IO hacia MoonWolf Cloud.

use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use bytes::{Bytes, BytesMut};
use futures::{StreamExt, future::FutureExt};
use rust_socketio::asynchronous::{Client, ClientBuilder};
use rust_socketio::{Event, Payload, TransportType};
use serde_json::json;
use tokio::sync::{Mutex, RwLock};
use tracing::{debug, error, info, warn};
use webrtc::{
    data_channel::{DataChannel, DataChannelEvent},
    peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
        RTCIceCandidateInit, RTCIceServer, RTCPeerConnectionIceEvent, RTCSessionDescription,
    },
};

use crate::{AppState, LOCAL_PORT, LogEntry, sleep_ms};

const RECONNECT_BASE_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;
const CONNECT_WAIT_MS: u64 = 20_000;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const HEALTHY_CONNECTION: Duration = Duration::from_secs(60);
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

const DIRECT_REQ_HEAD: u8 = 1;
const DIRECT_REQ_BODY: u8 = 2;
const DIRECT_REQ_END: u8 = 3;
const DIRECT_REQ_CANCEL: u8 = 4;
const DIRECT_RES_HEAD: u8 = 17;
const DIRECT_RES_BODY: u8 = 18;
const DIRECT_RES_END: u8 = 19;
const DIRECT_RES_ERR: u8 = 20;
const DIRECT_FRAME_BYTES: usize = 16_000;
const DIRECT_MAX_REQUEST_BODY: usize = 10 * 1024 * 1024;

type DirectPeerMap = Arc<Mutex<HashMap<String, Arc<dyn PeerConnection>>>>;
type PendingIceMap = Arc<Mutex<HashMap<String, Vec<RTCIceCandidateInit>>>>;

#[derive(Clone)]
struct DirectPeerHandler {
    peer_id: String,
    socket: Client,
    app: Arc<RwLock<AppState>>,
}

#[derive(Clone)]
struct DirectRequestHead {
    method: String,
    path: String,
    content_type: String,
}

struct DirectRequest {
    head: DirectRequestHead,
    body: Vec<u8>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for DirectPeerHandler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        let Ok(candidate) = event.candidate.to_json() else {
            return;
        };
        if candidate.candidate.is_empty() {
            return;
        }

        let message = json!({
            "peerId": self.peer_id,
            "type": "candidate",
            "candidate": candidate.candidate,
            "sdpMid": candidate.sdp_mid.unwrap_or_else(|| "0".to_owned()),
        });
        if let Err(error) = self.socket.emit("direct_signal", message).await {
            debug!("WebRTC ICE candidate {}: {error}", self.peer_id);
        }
    }

    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        let label = match channel.label().await {
            Ok(label) => label,
            Err(error) => {
                debug!("WebRTC no pudo leer la etiqueta del canal: {error}");
                let _ = channel.close().await;
                return;
            }
        };
        if label != "moonwolf" {
            warn!("WebRTC rechazó un canal de datos desconocido: {label}");
            let _ = channel.close().await;
            return;
        }

        let app = Arc::clone(&self.app);
        tokio::spawn(async move {
            handle_direct_data_channel(channel, app).await;
        });
    }
}

fn direct_route_matches(path: &str, pattern: &str) -> bool {
    let actual: Vec<&str> = path.split('/').collect();
    let expected: Vec<&str> = pattern.split('/').collect();
    actual.len() == expected.len()
        && expected
            .iter()
            .zip(actual.iter())
            .all(|(expected, actual)| expected.starts_with(':') || expected == actual)
}

fn direct_route_allowed(method: &str, path: &str) -> bool {
    if path.contains("://") || path.starts_with("//") || !path.starts_with("/api/") {
        return false;
    }
    let route = path.split('?').next().unwrap_or(path);
    [
        ("GET", "/api/files"),
        ("GET", "/api/files/content"),
        ("POST", "/api/files/content"),
        ("GET", "/api/files/download"),
        ("POST", "/api/files/upload-chunk"),
        ("GET", "/api/backups/download/:name"),
    ]
    .iter()
    .any(|(allowed_method, pattern)| {
        *allowed_method == method && direct_route_matches(route, pattern)
    })
}

async fn send_direct_frame(
    channel: &Arc<dyn DataChannel>,
    send_lock: &Mutex<()>,
    kind: u8,
    id: u32,
    payload: &[u8],
) -> anyhow::Result<()> {
    let mut frame = BytesMut::with_capacity(5 + payload.len());
    frame.extend_from_slice(&[kind]);
    frame.extend_from_slice(&id.to_be_bytes());
    frame.extend_from_slice(payload);
    let _guard = send_lock.lock().await;
    channel
        .send(frame)
        .await
        .map_err(|error| anyhow::anyhow!("WebRTC send: {error}"))
}

async fn send_direct_error(
    channel: &Arc<dyn DataChannel>,
    send_lock: &Mutex<()>,
    id: u32,
    message: &str,
) {
    let _ = send_direct_frame(channel, send_lock, DIRECT_RES_ERR, id, message.as_bytes()).await;
}

async fn handle_direct_data_channel(channel: Arc<dyn DataChannel>, app: Arc<RwLock<AppState>>) {
    let send_lock = Arc::new(Mutex::new(()));
    let mut requests: HashMap<u32, DirectRequest> = HashMap::new();

    while let Some(event) = channel.poll().await {
        let message = match event {
            DataChannelEvent::OnMessage(message) => message,
            DataChannelEvent::OnClose | DataChannelEvent::OnError => break,
            _ => continue,
        };

        let frame = message.data;
        if frame.len() < 5 {
            continue;
        }
        let kind = frame[0];
        let id = u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]);
        let payload = &frame[5..];

        match kind {
            DIRECT_REQ_HEAD => {
                let parsed = serde_json::from_slice::<serde_json::Value>(payload);
                let Ok(head) = parsed else {
                    send_direct_error(&channel, &send_lock, id, "Cabecera de solicitud no válida")
                        .await;
                    continue;
                };
                let method = head
                    .get("method")
                    .and_then(|value| value.as_str())
                    .unwrap_or("GET")
                    .to_ascii_uppercase();
                let path = head
                    .get("path")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_owned();
                let content_type = head
                    .get("contentType")
                    .and_then(|value| value.as_str())
                    .unwrap_or("application/octet-stream")
                    .to_owned();

                if !direct_route_allowed(&method, &path) {
                    send_direct_error(
                        &channel,
                        &send_lock,
                        id,
                        "Ruta no permitida para el canal directo",
                    )
                    .await;
                    continue;
                }

                requests.insert(
                    id,
                    DirectRequest {
                        head: DirectRequestHead {
                            method,
                            path,
                            content_type,
                        },
                        body: Vec::new(),
                    },
                );
            }
            DIRECT_REQ_BODY => {
                let exceeds_limit = requests
                    .get(&id)
                    .map(|request| {
                        request.body.len().saturating_add(payload.len()) > DIRECT_MAX_REQUEST_BODY
                    })
                    .unwrap_or(false);
                if exceeds_limit {
                    requests.remove(&id);
                    send_direct_error(
                        &channel,
                        &send_lock,
                        id,
                        "El cuerpo de la solicitud supera el límite permitido",
                    )
                    .await;
                    continue;
                }
                if let Some(request) = requests.get_mut(&id) {
                    request.body.extend_from_slice(payload);
                }
            }
            DIRECT_REQ_END => {
                let Some(request) = requests.remove(&id) else {
                    continue;
                };
                let channel = Arc::clone(&channel);
                let app = Arc::clone(&app);
                let send_lock = Arc::clone(&send_lock);
                tokio::spawn(async move {
                    if let Err(error) =
                        process_direct_http_request(&channel, &send_lock, &app, id, request).await
                    {
                        debug!("WebRTC solicitud {id}: {error:#}");
                        send_direct_error(&channel, &send_lock, id, &error.to_string()).await;
                    }
                });
            }
            DIRECT_REQ_CANCEL => {
                requests.remove(&id);
            }
            _ => {}
        }
    }
    requests.clear();
}

async fn process_direct_http_request(
    channel: &Arc<dyn DataChannel>,
    send_lock: &Mutex<()>,
    app: &Arc<RwLock<AppState>>,
    id: u32,
    request: DirectRequest,
) -> anyhow::Result<()> {
    let token = app.read().await.config.local_token.clone();
    let url = format!("http://127.0.0.1:{}{}", LOCAL_PORT, request.head.path);
    let client = HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(8)
            .build()
            .expect("HTTP client")
    });

    let mut builder = match request.head.method.as_str() {
        "POST" => client.post(&url),
        "GET" => client.get(&url),
        _ => anyhow::bail!("Método no permitido para el canal directo"),
    }
    .header("Authorization", format!("Bearer {token}"))
    .header("X-MoonWolf-Token", &token)
    .timeout(Duration::from_secs(120));

    if request.head.method == "POST" {
        builder = builder
            .header(reqwest::header::CONTENT_TYPE, &request.head.content_type)
            .body(request.body);
    }

    let response = builder.send().await?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let content_length = response.content_length().unwrap_or(0);

    let header = serde_json::to_vec(&json!({
        "status": status,
        "contentType": content_type,
        "contentLength": content_length,
    }))?;
    send_direct_frame(channel, send_lock, DIRECT_RES_HEAD, id, &header).await?;

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        for part in chunk.chunks(DIRECT_FRAME_BYTES) {
            send_direct_frame(channel, send_lock, DIRECT_RES_BODY, id, part).await?;
        }
    }

    send_direct_frame(channel, send_lock, DIRECT_RES_END, id, &[]).await?;
    Ok(())
}

fn direct_ice_servers(value: Option<&serde_json::Value>) -> Vec<RTCIceServer> {
    let mut servers: Vec<RTCIceServer> = value
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let urls = match entry.get("urls") {
                Some(serde_json::Value::String(url)) => vec![url.clone()],
                Some(serde_json::Value::Array(urls)) => urls
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                _ => Vec::new(),
            };
            if urls.is_empty() {
                None
            } else {
                Some(RTCIceServer {
                    urls,
                    ..Default::default()
                })
            }
        })
        .collect();

    if servers.is_empty() {
        servers = vec![
            RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_owned()],
                ..Default::default()
            },
            RTCIceServer {
                urls: vec!["stun:stun.cloudflare.com:3478".to_owned()],
                ..Default::default()
            },
        ];
    }
    servers
}

async fn close_direct_peer(peers: &DirectPeerMap, peer_id: &str) {
    let peer = peers.lock().await.remove(peer_id);
    if let Some(peer) = peer {
        let _ = peer.close().await;
    }
}

async fn handle_direct_signal(
    app: Arc<RwLock<AppState>>,
    socket: Client,
    peers: DirectPeerMap,
    pending_ice: PendingIceMap,
    message: serde_json::Value,
) {
    let peer_id = message
        .get("peerId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned();
    if peer_id.is_empty() || peer_id.len() > 128 {
        return;
    }

    match message
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
    {
        "offer" => {
            let permission = message
                .get("ctx")
                .and_then(|ctx| ctx.get("permission"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("read");
            if permission != "admin" {
                let _ = socket
                    .emit(
                        "direct_signal",
                        json!({"peerId":peer_id,"type":"unavailable"}),
                    )
                    .await;
                return;
            }

            let sdp = message
                .get("sdp")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if sdp.is_empty() || sdp.len() > 32_768 {
                let _ = socket
                    .emit(
                        "direct_signal",
                        json!({"peerId":peer_id,"type":"unavailable"}),
                    )
                    .await;
                return;
            }

            close_direct_peer(&peers, &peer_id).await;

            let handler = Arc::new(DirectPeerHandler {
                peer_id: peer_id.clone(),
                socket: socket.clone(),
                app: Arc::clone(&app),
            });
            let configuration = RTCConfigurationBuilder::default()
                .with_ice_servers(direct_ice_servers(message.get("iceServers")))
                .build();

            let peer = match PeerConnectionBuilder::new()
                .with_configuration(configuration)
                .with_handler(handler)
                .with_udp_addrs(vec!["0.0.0.0:0"])
                .with_data_channel_send_buffer_limit(8 * 1024 * 1024)
                .build()
                .await
            {
                Ok(peer) => Arc::new(peer) as Arc<dyn PeerConnection>,
                Err(error) => {
                    warn!("WebRTC no pudo crear la conexión {peer_id}: {error}");
                    let _ = socket
                        .emit(
                            "direct_signal",
                            json!({"peerId":peer_id,"type":"unavailable"}),
                        )
                        .await;
                    return;
                }
            };

            let offer: RTCSessionDescription = match serde_json::from_value(json!({
                "type": "offer",
                "sdp": sdp,
            })) {
                Ok(offer) => offer,
                Err(error) => {
                    warn!("WebRTC oferta no válida {peer_id}: {error}");
                    let _ = peer.close().await;
                    let _ = socket
                        .emit(
                            "direct_signal",
                            json!({"peerId":peer_id,"type":"unavailable"}),
                        )
                        .await;
                    return;
                }
            };

            if let Err(error) = peer.set_remote_description(offer).await {
                warn!("WebRTC no pudo aplicar la oferta {peer_id}: {error}");
                let _ = peer.close().await;
                let _ = socket
                    .emit(
                        "direct_signal",
                        json!({"peerId":peer_id,"type":"unavailable"}),
                    )
                    .await;
                return;
            }

            peers
                .lock()
                .await
                .insert(peer_id.clone(), Arc::clone(&peer));
            let queued = pending_ice
                .lock()
                .await
                .remove(&peer_id)
                .unwrap_or_default();
            for candidate in queued {
                if let Err(error) = peer.add_ice_candidate(candidate).await {
                    debug!("WebRTC candidato ICE pendiente {peer_id}: {error}");
                }
            }

            let answer = match peer.create_answer(None).await {
                Ok(answer) => answer,
                Err(error) => {
                    warn!("WebRTC no pudo crear la respuesta {peer_id}: {error}");
                    close_direct_peer(&peers, &peer_id).await;
                    let _ = socket
                        .emit(
                            "direct_signal",
                            json!({"peerId":peer_id,"type":"unavailable"}),
                        )
                        .await;
                    return;
                }
            };
            if let Err(error) = peer.set_local_description(answer).await {
                warn!("WebRTC no pudo aplicar la respuesta local {peer_id}: {error}");
                close_direct_peer(&peers, &peer_id).await;
                let _ = socket
                    .emit(
                        "direct_signal",
                        json!({"peerId":peer_id,"type":"unavailable"}),
                    )
                    .await;
                return;
            }
            let Some(local) = peer.local_description().await else {
                close_direct_peer(&peers, &peer_id).await;
                let _ = socket
                    .emit(
                        "direct_signal",
                        json!({"peerId":peer_id,"type":"unavailable"}),
                    )
                    .await;
                return;
            };
            if let Err(error) = socket
                .emit(
                    "direct_signal",
                    json!({"peerId":peer_id,"type":"answer","sdp":local.sdp}),
                )
                .await
            {
                warn!("WebRTC no pudo enviar la respuesta {peer_id}: {error}");
                close_direct_peer(&peers, &peer_id).await;
            }
        }
        "candidate" => {
            let candidate_text = message
                .get("candidate")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if candidate_text.is_empty() || candidate_text.len() > 2_048 {
                return;
            }
            let candidate: RTCIceCandidateInit = match serde_json::from_value(json!({
                "candidate": candidate_text,
                "sdpMid": message
                    .get("sdpMid")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("0"),
            })) {
                Ok(candidate) => candidate,
                Err(error) => {
                    debug!("WebRTC candidato ICE no válido {peer_id}: {error}");
                    return;
                }
            };
            let peer = peers.lock().await.get(&peer_id).cloned();
            if let Some(peer) = peer {
                if let Err(error) = peer.add_ice_candidate(candidate).await {
                    debug!("WebRTC no pudo añadir candidato ICE {peer_id}: {error}");
                }
            } else {
                let mut pending = pending_ice.lock().await;
                let queue = pending.entry(peer_id).or_default();
                if queue.len() < 64 {
                    queue.push(candidate);
                }
            }
        }
        _ => {}
    }
}

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

    let direct_peers: DirectPeerMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_ice: PendingIceMap = Arc::new(Mutex::new(HashMap::new()));

    let app_on_connect = Arc::clone(&app);
    let app_on_close = Arc::clone(&app);
    let app_on_error = Arc::clone(&app);

    let client = ClientBuilder::new(panel_url)
        .namespace("/")
        // El endpoint de Render/Cloudflare mantiene WebSocket extremo a extremo;
        // usarlo directamente evita que rust_engineio intente parsear chunks
        // HTTP fragmentados del polling como si fueran paquetes completos.
        .transport_type(TransportType::Websocket)
        .auth(auth)
        .on(Event::Connect, move |_, socket: Client| {
            let app = Arc::clone(&app_on_connect);
            async move {
                info!("Socket Cloud conectado");
                if let Err(e) = socket
                    .emit("agent_capabilities", json!({"rpcBinary": true}))
                    .await
                {
                    warn!("No se pudo anunciar RPC binario: {e}");
                }
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
                    s.add_log(
                        "error",
                        humanize_cloud_error(&format!("connect_error: {msg}")),
                    );
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
                    s.add_log(
                        "info",
                        format!("Código de emparejamiento disponible: {code}"),
                    );
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
        .on("rpc_binary", {
            let app = Arc::clone(&app);
            move |payload: Payload, socket: Client| {
                let app = Arc::clone(&app);
                async move {
                    match handle_rpc_binary(&app, &payload).await {
                        Ok(packet) => {
                            if let Err(error) = socket
                                .emit("rpc_result_binary", Payload::Binary(Bytes::from(packet)))
                                .await
                            {
                                warn!("rpc_result_binary emit: {error}");
                            }
                        }
                        Err(error) => warn!("RPC binario no válido: {error:#}"),
                    }
                }
                .boxed()
            }
        })
        .on("direct_signal", {
            let app = Arc::clone(&app);
            let peers = Arc::clone(&direct_peers);
            let pending_ice = Arc::clone(&pending_ice);
            move |payload: Payload, socket: Client| {
                let app = Arc::clone(&app);
                let peers = Arc::clone(&peers);
                let pending_ice = Arc::clone(&pending_ice);
                async move {
                    let message = payload_json(&payload);
                    handle_direct_signal(app, socket, peers, pending_ice, message).await;
                }
                .boxed()
            }
        })
        .on("direct_close", {
            let peers = Arc::clone(&direct_peers);
            let pending_ice = Arc::clone(&pending_ice);
            move |payload: Payload, _| {
                let peers = Arc::clone(&peers);
                let pending_ice = Arc::clone(&pending_ice);
                async move {
                    let message = payload_json(&payload);
                    if let Some(peer_id) = message.get("peerId").and_then(serde_json::Value::as_str)
                    {
                        close_direct_peer(&peers, peer_id).await;
                        pending_ice.lock().await.remove(peer_id);
                    }
                }
                .boxed()
            }
        })
        .on("direct_ctx", {
            let peers = Arc::clone(&direct_peers);
            let pending_ice = Arc::clone(&pending_ice);
            move |payload: Payload, _| {
                let peers = Arc::clone(&peers);
                let pending_ice = Arc::clone(&pending_ice);
                async move {
                    let message = payload_json(&payload);
                    if let Some(peer_id) = message.get("peerId").and_then(serde_json::Value::as_str)
                    {
                        let permission = message
                            .get("permission")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("read");
                        if permission != "admin" {
                            close_direct_peer(&peers, peer_id).await;
                            pending_ice.lock().await.remove(peer_id);
                        }
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
        .map_err(|e| anyhow::anyhow!("connect falló: {e:?}"))?;

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
    // Al (re)conectar, sincronizar el estado del proceso Java con el backend.
    // Si no, el panel puede quedarse en offline aunque el servidor ya esté arriba.
    {
        let status = if last_mc_running {
            "starting"
        } else {
            "offline"
        };
        let _ = client
            .emit(
                "event",
                json!({
                    "name": "status",
                    "payload": status,
                }),
            )
            .await;
    }
    let mut last_heartbeat = Instant::now();
    let mut last_activity = Instant::now();
    let mut last_stats = Instant::now() - Duration::from_secs(10);
    let mut last_cpu: Option<(u64, u64)> = None; // (proc_time_units, wall_ms)
    const STATS_INTERVAL: Duration = Duration::from_secs(5);

    loop {
        sleep_ms(500).await;

        let (shutting_down, connected, console_seq, mc_running) = {
            let s = app.read().await;
            (
                s.shutting_down,
                s.cloud_connected,
                s.console_seq,
                s.mc_running,
            )
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
                let event_name = if new_logs.len() == 1 {
                    "log"
                } else {
                    "log_batch"
                };
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
            // Al arrancar el proceso Java emitimos "starting".
            // El backend pasa a "online" cuando detecta el log de listo del servidor.
            let status = if mc_running { "starting" } else { "offline" };
            let _ = client
                .emit(
                    "event",
                    json!({
                        "name": "status",
                        "payload": status,
                    }),
                )
                .await;
            last_mc_running = mc_running;
            last_activity = Instant::now();
        }

        if last_heartbeat.elapsed() >= HEARTBEAT_INTERVAL {
            // Heartbeat de presencia. Solo reafirmamos "offline".
            // El estado "starting"/"online" lo gestiona el backend a partir de logs.
            if !mc_running {
                match client
                    .emit(
                        "event",
                        json!({
                            "name": "status",
                            "payload": "offline",
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
            } else {
                // Solo marcar actividad; no pisar el status del backend.
                last_heartbeat = Instant::now();
                last_activity = Instant::now();
            }
        }

        // Métricas: RCON (jugadores) + SO (RAM/CPU) + uptime del proceso Java.
        if mc_running && last_stats.elapsed() >= STATS_INTERVAL {
            let (server_dir, pid, started) = {
                let s = app.read().await;
                (s.config.server_dir.clone(), s.mc_pid, s.mc_started_at_ms)
            };
            let stats = collect_server_stats(&app, &server_dir, pid, started, &mut last_cpu).await;
            if let Err(e) = client
                .emit(
                    "event",
                    json!({
                        "name": "stats",
                        "payload": stats,
                    }),
                )
                .await
            {
                warn!("emit stats falló: {e}");
                break;
            }
            last_stats = Instant::now();
            last_activity = Instant::now();
        }

        if last_activity.elapsed() >= IDLE_TIMEOUT {
            warn!("Sin actividad en 60 s; cerrando socket para reconectar");
            break;
        }
    }

    let _ = client.disconnect().await;
    let remaining: Vec<Arc<dyn PeerConnection>> = {
        let mut peers = direct_peers.lock().await;
        peers.drain().map(|(_, peer)| peer).collect()
    };
    for peer in remaining {
        let _ = peer.close().await;
    }
    pending_ice.lock().await.clear();
    Ok(())
}

fn log_to_panel(entry: &LogEntry) -> serde_json::Value {
    let time = crate::format_hms_ms(entry.time);
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
    if lower.contains("engineio")
        || lower.contains("engine.io")
        || lower.contains("incomplete response")
    {
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

const RPC_BINARY_MAGIC: &[u8; 4] = b"MWR1";
const RPC_BINARY_MAX_HEADER: usize = 64 * 1024;

fn decode_rpc_binary_packet(packet: &[u8]) -> anyhow::Result<(serde_json::Value, &[u8])> {
    if packet.len() < 8 || &packet[..4] != RPC_BINARY_MAGIC {
        anyhow::bail!("Cabecera de RPC binario no válida");
    }
    let header_len = u32::from_be_bytes(
        packet[4..8]
            .try_into()
            .map_err(|_| anyhow::anyhow!("Longitud de cabecera no válida"))?,
    ) as usize;
    if header_len == 0 || header_len > RPC_BINARY_MAX_HEADER {
        anyhow::bail!("Longitud de cabecera RPC fuera de rango");
    }
    let body_start = 8usize
        .checked_add(header_len)
        .ok_or_else(|| anyhow::anyhow!("Desbordamiento de cabecera RPC"))?;
    if body_start > packet.len() {
        anyhow::bail!("Paquete RPC incompleto");
    }
    let header: serde_json::Value = serde_json::from_slice(&packet[8..body_start])?;
    if !header.is_object() {
        anyhow::bail!("Metadatos RPC no válidos");
    }
    Ok((header, &packet[body_start..]))
}

fn encode_rpc_binary_packet(header: &serde_json::Value, body: &[u8]) -> anyhow::Result<Vec<u8>> {
    let header = serde_json::to_vec(header)?;
    if header.is_empty() || header.len() > RPC_BINARY_MAX_HEADER {
        anyhow::bail!("Metadatos RPC demasiado grandes");
    }
    let header_len = u32::try_from(header.len())?;
    let mut packet = BytesMut::with_capacity(8 + header.len() + body.len());
    packet.extend_from_slice(RPC_BINARY_MAGIC);
    packet.extend_from_slice(&header_len.to_be_bytes());
    packet.extend_from_slice(&header);
    packet.extend_from_slice(body);
    Ok(packet.to_vec())
}

async fn execute_rpc_request(
    app: &Arc<RwLock<AppState>>,
    method: &str,
    path: &str,
    body: Option<(Vec<u8>, String)>,
) -> (u16, bool, String, Vec<u8>) {
    let token = app.read().await.config.local_token.clone();
    let url = format!("http://127.0.0.1:{}{}", LOCAL_PORT, path);
    let client = HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(8)
            .build()
            .expect("reqwest client")
    });

    let mut builder = match method {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        "PATCH" => client.patch(&url),
        _ => client.get(&url),
    }
    .header("Authorization", format!("Bearer {token}"))
    .header("X-MoonWolf-Token", &token)
    .timeout(Duration::from_secs(120));

    if let Some((body, content_type)) = body {
        builder = builder
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(body);
    }

    match builder.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let ok = response.status().is_success();
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("application/json")
                .to_owned();
            let body = response.bytes().await.unwrap_or_default().to_vec();
            (status, ok, content_type, body)
        }
        Err(error) => {
            let body = serde_json::to_vec(&json!({"ok": false, "error": error.to_string()}))
                .unwrap_or_default();
            (502, false, "application/json".to_owned(), body)
        }
    }
}

async fn handle_rpc(app: &Arc<RwLock<AppState>>, payload: &Payload) -> serde_json::Value {
    let request = payload_json(payload);
    let method = request
        .get("method")
        .and_then(|value| value.as_str())
        .unwrap_or("GET")
        .to_ascii_uppercase();
    let path = request
        .get("path")
        .and_then(|value| value.as_str())
        .unwrap_or("/api/health");
    let id = request.get("id").cloned().unwrap_or(json!(null));
    let body = request
        .get("body")
        .filter(|value| !value.is_null())
        .and_then(|value| serde_json::to_vec(value).ok())
        .map(|bytes| (bytes, "application/json".to_owned()));

    let (status, ok, content_type, body) = execute_rpc_request(app, &method, path, body).await;

    json!({
        "id": id,
        "ok": ok,
        "status": status,
        "contentType": content_type,
        "bodyBase64": crate::b64_std_encode(&body),
    })
}

async fn handle_rpc_binary(
    app: &Arc<RwLock<AppState>>,
    payload: &Payload,
) -> anyhow::Result<Vec<u8>> {
    let Payload::Binary(packet) = payload else {
        anyhow::bail!("Se esperaba un paquete Socket.IO binario");
    };
    let (request, body_bytes) = decode_rpc_binary_packet(packet.as_ref())?;
    let method = request
        .get("method")
        .and_then(|value| value.as_str())
        .unwrap_or("GET")
        .to_ascii_uppercase();
    let path = request
        .get("path")
        .and_then(|value| value.as_str())
        .unwrap_or("/api/health");
    let id = request
        .get("id")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let has_body = request
        .get("hasBody")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(!body_bytes.is_empty());
    let body = if has_body {
        let content_type = request
            .get("contentType")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("application/octet-stream")
            .to_owned();
        Some((body_bytes.to_vec(), content_type))
    } else {
        None
    };

    let (status, ok, content_type, response_body) =
        execute_rpc_request(app, &method, path, body).await;
    let response_header = json!({
        "id": id,
        "ok": ok,
        "status": status,
        "contentType": content_type,
    });
    encode_rpc_binary_packet(&response_header, &response_body)
}

/* ══════════════════════════════════════════════
MÉTRICAS (RCON + proceso/sistema)
══════════════════════════════════════════════ */

async fn collect_server_stats(
    app: &Arc<RwLock<AppState>>,
    server_dir: &std::path::Path,
    java_pid: Option<u32>,
    started_at_ms: Option<i64>,
    last_cpu: &mut Option<(u64, u64)>,
) -> serde_json::Value {
    let mut players = 0u32;
    let mut max_players = 0u32;
    let mut process_memory = 0u64;
    let mut cpu_usage = 0.0f64;

    if let Some(pid) = java_pid {
        if let Some(mb) = process_memory_mb(pid) {
            process_memory = mb;
        }
        if let Some(cpu) = sample_process_cpu(pid, last_cpu) {
            cpu_usage = cpu;
        }
    }

    // Si MoonWolf Agent ha iniciado el servidor, podemos consultar su consola
    // directamente. RCON queda como respaldo para servidores sin consola local.
    match local_console_command(app, "list").await {
        Some(output) => {
            if let Some((online, max)) = parse_list_response(&output) {
                players = online;
                max_players = max;
            } else {
                debug!("No se pudo interpretar la respuesta local de list: {output}");
            }
        }
        None => match rcon_list_players(server_dir).await {
            Ok((online, max)) => {
                players = online;
                max_players = max;
            }
            Err(e) => debug!("RCON list: {e}"),
        },
    }

    // Paper/Spigot y sus derivados suelen ofrecer /tps. Vanilla incorporó
    // /tick query en 1.20.3. No se inventa un valor si ningún método responde.
    let mut tps = query_tps(app, server_dir, "tps").await;
    if tps.is_none() && server_version_at_least(server_dir, (1, 20, 3)).await {
        tps = query_tps(app, server_dir, "tick query").await;
    }

    if max_players == 0 {
        if let Some(max) = read_max_players_prop(server_dir).await {
            max_players = max;
        }
    }

    let sys = system_memory().unwrap_or((0.0, 0.0));

    json!({
        "players": players,
        "maxPlayers": max_players,
        "tps": tps,
        "processMemory": process_memory,
        "cpuUsage": cpu_usage,
        "uptime": format_uptime(started_at_ms),
        "sysMemory": {
            "used": sys.0,
            "total": sys.1,
        },
    })
}

async fn query_tps(
    app: &Arc<RwLock<AppState>>,
    server_dir: &std::path::Path,
    command: &str,
) -> Option<f64> {
    if let Some(output) = local_console_command(app, command).await {
        if let Some(tps) = parse_tps_response(&output) {
            return Some(tps);
        }
    }
    rcon_command_output(server_dir, command)
        .await
        .ok()
        .and_then(|output| parse_tps_response(&output))
}

async fn local_console_command(app: &Arc<RwLock<AppState>>, command: &str) -> Option<String> {
    let (token, before_seq, running) = {
        let state = app.read().await;
        (
            state.config.local_token.clone(),
            state.console_seq,
            state.mc_running,
        )
    };
    if !running {
        return None;
    }

    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{LOCAL_PORT}/api/command"))
        .bearer_auth(token)
        .json(&json!({ "cmd": command }))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    if body.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        return None;
    }

    // La API confirma el envío; la respuesta del juego llega de forma asíncrona
    // por stdout/stderr y se recoge del búfer de consola del propio Agent.
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1100);
    let mut output = Vec::new();
    loop {
        {
            let state = app.read().await;
            for entry in state
                .console_logs
                .iter()
                .filter(|entry| entry.seq > before_seq)
            {
                let line = entry.message.trim();
                if !line.is_empty() && !line.starts_with('>') {
                    output.push(line.to_string());
                }
            }
        }
        let combined = output.join("\n");
        if command == "list" && parse_list_response(&combined).is_some() {
            return Some(combined);
        }
        if command == "tps" && parse_tps_response(&combined).is_some() {
            return Some(combined);
        }
        if command == "tick query" && parse_tps_response(&combined).is_some() {
            return Some(combined);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn parse_tps_response(output: &str) -> Option<f64> {
    let lower = output.to_ascii_lowercase();
    let tps_pos = lower.rfind("tps")?;
    let before = &output[..tps_pos];
    let after = &output[tps_pos + 3..];

    // Paper: "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0".
    // Vanilla: "Average tick time: ... (20.0 TPS)".
    let candidate = if let Some(colon) = after.find(':') {
        let values = &after[colon + 1..];
        values
            .split(|c: char| !(c.is_ascii_digit() || c == '.'))
            .filter(|part| !part.is_empty())
            .find_map(|part| part.parse::<f64>().ok())
    } else {
        before
            .split(|c: char| !(c.is_ascii_digit() || c == '.'))
            .filter(|part| !part.is_empty())
            .filter_map(|part| part.parse::<f64>().ok())
            .last()
    }?;

    if candidate.is_finite() && (0.0..=20.1).contains(&candidate) {
        Some(candidate.min(20.0))
    } else {
        None
    }
}

async fn server_version_at_least(server_dir: &std::path::Path, minimum: (u32, u32, u32)) -> bool {
    let log = match tokio::fs::read_to_string(server_dir.join("logs").join("latest.log")).await {
        Ok(log) => log,
        Err(_) => return false,
    };
    let lower = log.to_ascii_lowercase();
    let marker = "starting minecraft server version ";
    let Some(index) = lower.rfind(marker) else {
        return false;
    };
    let version = log[index + marker.len()..]
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
    let mut parts = version
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    let found = (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    );
    found >= minimum
}

fn format_uptime(started_at_ms: Option<i64>) -> String {
    let Some(start) = started_at_ms else {
        return "0h 0m".into();
    };
    let now = crate::now_ms();
    if now <= start {
        return "0h 0m".into();
    }
    let total_secs = ((now - start) / 1000) as u64;
    let hours = total_secs / 3600;
    let mins = (total_secs % 3600) / 60;
    if hours >= 24 {
        let days = hours / 24;
        let h = hours % 24;
        format!("{days}d {h}h {mins}m")
    } else {
        format!("{hours}h {mins}m")
    }
}

async fn read_max_players_prop(server_dir: &std::path::Path) -> Option<u32> {
    let text = tokio::fs::read_to_string(server_dir.join("server.properties"))
        .await
        .ok()?;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("max-players=") {
            return rest.trim().parse().ok();
        }
    }
    None
}

async fn read_rcon_config(server_dir: &std::path::Path) -> Option<(u16, String)> {
    let text = tokio::fs::read_to_string(server_dir.join("server.properties"))
        .await
        .ok()?;
    let mut enabled = false;
    let mut port = 25575u16;
    let mut password = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "enable-rcon" => enabled = v.trim().eq_ignore_ascii_case("true"),
                "rcon.port" => {
                    if let Ok(p) = v.trim().parse() {
                        port = p;
                    }
                }
                "rcon.password" => password = v.trim().to_string(),
                _ => {}
            }
        }
    }
    if enabled && !password.is_empty() {
        Some((port, password))
    } else {
        None
    }
}

async fn rcon_list_players(server_dir: &std::path::Path) -> anyhow::Result<(u32, u32)> {
    let body = rcon_command_output(server_dir, "list").await?;
    parse_list_response(&body).ok_or_else(|| anyhow::anyhow!("No se pudo parsear list: {body}"))
}

async fn rcon_command_output(
    server_dir: &std::path::Path,
    command: &str,
) -> anyhow::Result<String> {
    use tokio::net::TcpStream;
    use tokio::time::timeout;

    const RCON_TIMEOUT: Duration = Duration::from_secs(3);
    const RCON_AUTH: i32 = 3;
    const RCON_EXEC: i32 = 2;
    const RCON_RESPONSE: i32 = 0;

    let (port, password) = read_rcon_config(server_dir)
        .await
        .ok_or_else(|| anyhow::anyhow!("RCON no configurado"))?;

    let mut stream = timeout(
        RCON_TIMEOUT,
        TcpStream::connect(format!("127.0.0.1:{port}")),
    )
    .await??;
    let _ = stream.set_nodelay(true);

    rcon_write_packet(&mut stream, 1, RCON_AUTH, &password).await?;
    let (id, typ, _) = rcon_read_packet(&mut stream).await?;
    if typ == RCON_RESPONSE {
        let (id2, _typ2, _) = rcon_read_packet(&mut stream).await?;
        if id2 == -1 {
            anyhow::bail!("RCON auth rechazada");
        }
    } else if id == -1 {
        anyhow::bail!("RCON auth rechazada");
    }

    rcon_write_packet(&mut stream, 2, RCON_EXEC, command).await?;
    let mut body = String::new();
    loop {
        match timeout(Duration::from_millis(800), rcon_read_packet(&mut stream)).await {
            Ok(Ok((_id, typ, payload))) => {
                if typ == RCON_RESPONSE || typ == RCON_EXEC {
                    body.push_str(&payload);
                    if payload.is_empty() {
                        break;
                    }
                } else {
                    break;
                }
            }
            _ => break,
        }
    }

    if body.is_empty() {
        anyhow::bail!("RCON no devolvió respuesta para {command}");
    }
    Ok(body)
}

async fn rcon_write_packet(
    stream: &mut tokio::net::TcpStream,
    id: i32,
    typ: i32,
    body: &str,
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    use tokio::time::timeout;
    const RCON_TIMEOUT: Duration = Duration::from_secs(3);
    let body_bytes = body.as_bytes();
    let len = (4 + 4 + body_bytes.len() + 2) as i32;
    let mut buf = Vec::with_capacity(4 + len as usize);
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(&id.to_le_bytes());
    buf.extend_from_slice(&typ.to_le_bytes());
    buf.extend_from_slice(body_bytes);
    buf.push(0);
    buf.push(0);
    timeout(RCON_TIMEOUT, stream.write_all(&buf)).await??;
    Ok(())
}

async fn rcon_read_packet(
    stream: &mut tokio::net::TcpStream,
) -> anyhow::Result<(i32, i32, String)> {
    use tokio::io::AsyncReadExt;
    use tokio::time::timeout;
    const RCON_TIMEOUT: Duration = Duration::from_secs(3);
    let mut len_buf = [0u8; 4];
    timeout(RCON_TIMEOUT, stream.read_exact(&mut len_buf)).await??;
    let len = i32::from_le_bytes(len_buf);
    if !(10..=4096).contains(&len) {
        anyhow::bail!("paquete RCON inválido (len={len})");
    }
    let mut data = vec![0u8; len as usize];
    timeout(RCON_TIMEOUT, stream.read_exact(&mut data)).await??;
    let id = i32::from_le_bytes(
        data[0..4]
            .try_into()
            .map_err(|_| anyhow::anyhow!("paquete RCON truncado (id)"))?,
    );
    let typ = i32::from_le_bytes(
        data[4..8]
            .try_into()
            .map_err(|_| anyhow::anyhow!("paquete RCON truncado (type)"))?,
    );
    let body_end = data.len().saturating_sub(2);
    let body = String::from_utf8_lossy(&data[8..body_end]).into_owned();
    Ok((id, typ, body))
}
fn parse_list_response(body: &str) -> Option<(u32, u32)> {
    let lower = body.to_ascii_lowercase();
    if let Some(idx) = lower.find("there are ") {
        let rest = &body[idx + "there are ".len()..];
        let mut nums = rest
            .split(|c: char| !c.is_ascii_digit())
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse::<u32>().ok());
        let online = nums.next()?;
        let max = nums.next().unwrap_or(0);
        return Some((online, max));
    }
    let digits: Vec<u32> = body
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    if digits.len() >= 2 {
        Some((digits[0], digits[1]))
    } else if digits.len() == 1 {
        Some((digits[0], 0))
    } else {
        None
    }
}

fn sample_process_cpu(pid: u32, last: &mut Option<(u64, u64)>) -> Option<f64> {
    let now_ms = crate::now_ms() as u64;
    let proc_time = process_cpu_time(pid)?;
    let sample = (proc_time, now_ms);
    let pct = if let Some((prev_proc, prev_wall)) = *last {
        let d_proc = sample.0.saturating_sub(prev_proc);
        let d_wall = sample.1.saturating_sub(prev_wall);
        if d_wall == 0 {
            0.0
        } else {
            #[cfg(windows)]
            let d_proc_ms = d_proc / 10_000;
            #[cfg(not(windows))]
            let d_proc_ms = d_proc;
            let cores = std::thread::available_parallelism()
                .map(|n| n.get() as f64)
                .unwrap_or(1.0)
                .max(1.0);
            let raw = (d_proc_ms as f64) / (d_wall as f64) * 100.0;
            (raw / cores).clamp(0.0, 100.0)
        }
    } else {
        0.0
    };
    *last = Some(sample);
    Some((pct * 10.0).round() / 10.0)
}

#[cfg(windows)]
fn system_memory() -> Option<(f64, f64)> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut st = std::mem::zeroed::<MEMORYSTATUSEX>();
        st.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut st) == 0 {
            return None;
        }
        let total = st.ullTotalPhys as f64 / (1024.0 * 1024.0 * 1024.0);
        let avail = st.ullAvailPhys as f64 / (1024.0 * 1024.0 * 1024.0);
        let used = (total - avail).max(0.0);
        Some(((used * 10.0).round() / 10.0, (total * 10.0).round() / 10.0))
    }
}

#[cfg(windows)]
fn process_memory_mb(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::OpenProcess;

    // Avoid depending on optional constant feature flags.
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const PROCESS_VM_READ: u32 = 0x0010;

    unsafe {
        let mut handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        }
        if handle.is_null() {
            return None;
        }
        let mut counters = std::mem::zeroed::<PROCESS_MEMORY_COUNTERS>();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let ok = GetProcessMemoryInfo(handle, &mut counters, counters.cb);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        Some((counters.WorkingSetSize as u64) / (1024 * 1024))
    }
}

#[cfg(windows)]
fn process_cpu_time(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess};

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;

    unsafe {
        let mut handle = OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
        if handle.is_null() {
            handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        }
        if handle.is_null() {
            return None;
        }
        let mut creation = std::mem::zeroed::<FILETIME>();
        let mut exit = std::mem::zeroed::<FILETIME>();
        let mut kernel = std::mem::zeroed::<FILETIME>();
        let mut user = std::mem::zeroed::<FILETIME>();
        let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let k = ((kernel.dwHighDateTime as u64) << 32) | kernel.dwLowDateTime as u64;
        let u = ((user.dwHighDateTime as u64) << 32) | user.dwLowDateTime as u64;
        Some(k + u)
    }
}

#[cfg(not(windows))]
fn system_memory() -> Option<(f64, f64)> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let mut total_kb = 0u64;
    let mut avail_kb = 0u64;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("MemTotal:") {
            total_kb = v.trim().trim_end_matches(" kB").trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("MemAvailable:") {
            avail_kb = v.trim().trim_end_matches(" kB").trim().parse().unwrap_or(0);
        }
    }
    if total_kb == 0 {
        return None;
    }
    let total = total_kb as f64 / (1024.0 * 1024.0);
    let used = (total_kb.saturating_sub(avail_kb)) as f64 / (1024.0 * 1024.0);
    Some(((used * 10.0).round() / 10.0, (total * 10.0).round() / 10.0))
}

#[cfg(not(windows))]
fn process_memory_mb(pid: u32) -> Option<u64> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("VmRSS:") {
            let kb: u64 = v.trim().trim_end_matches(" kB").trim().parse().ok()?;
            return Some(kb / 1024);
        }
    }
    None
}

#[cfg(not(windows))]
fn process_cpu_time(pid: u32) -> Option<u64> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rparen = text.rfind(')')?;
    let fields: Vec<&str> = text[rparen + 2..].split_whitespace().collect();
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    Some((utime + stime) * 10)
}

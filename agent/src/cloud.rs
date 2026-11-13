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
                if let Err(e) = socket.emit("agent_capabilities", json!({"rpcBinary": true})).await {
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

fn encode_rpc_binary_packet(
    header: &serde_json::Value,
    body: &[u8],
) -> anyhow::Result<Vec<u8>> {
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

    let (status, ok, content_type, body) =
        execute_rpc_request(app, &method, path, body).await;

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
    let id = request.get("id").cloned().unwrap_or(serde_json::Value::Null);
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

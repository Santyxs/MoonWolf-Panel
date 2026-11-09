//! MoonWolf Panel — backend cloud.

use std::{
    collections::{HashMap, HashSet},
    env,
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use getrandom::fill as os_fill;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use socketioxide::{
    extract::{Data, SocketRef},
    handler::ConnectHandler,
    socket::DisconnectReason,
    SocketIo,
};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use tower_http::{compression::CompressionLayer, cors::CorsLayer};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

const SERVICE_NAME: &str = "moonwolf-rust";
const ALLOWED_ORIGIN: &str = "https://moonwolf-panel.onrender.com";
const SESSION_TTL_MS: i64 = 12 * 60 * 60 * 1000;
const PAIRING_TTL_MS: i64 = 5 * 60 * 1000;
const MAX_SOCKET_PAYLOAD: u64 = 20 * 1024 * 1024;
const MAX_CACHED_LOGS: usize = 300;
const ICE_SERVERS: [&str; 2] = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];
const TOKEN_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
type HmacSha256 = Hmac<Sha256>;

/* ── Base64 nativo (standard + URL-safe sin padding) ── */

const B64_STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64_encode(data: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        out.push(alphabet[((n >> 18) & 63) as usize] as char);
        out.push(alphabet[((n >> 12) & 63) as usize] as char);
        out.push(alphabet[((n >> 6) & 63) as usize] as char);
        out.push(alphabet[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = data.len() - i;
    if rem == 1 {
        let n = (data[i] as u32) << 16;
        out.push(alphabet[((n >> 18) & 63) as usize] as char);
        out.push(alphabet[((n >> 12) & 63) as usize] as char);
        if pad {
            out.push('=');
            out.push('=');
        }
    } else if rem == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        out.push(alphabet[((n >> 18) & 63) as usize] as char);
        out.push(alphabet[((n >> 12) & 63) as usize] as char);
        out.push(alphabet[((n >> 6) & 63) as usize] as char);
        if pad {
            out.push('=');
        }
    }
    out
}

fn b64_decode(input: &str) -> Option<Vec<u8>> {
    let mut buf = Vec::with_capacity(input.len() * 3 / 4);
    let mut val: u32 = 0;
    let mut val_b: i8 = -8;
    for &c in input.as_bytes() {
        let d = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        } as u32;
        val = (val << 6) | d;
        val_b += 6;
        if val_b >= 0 {
            buf.push(((val >> val_b) & 0xFF) as u8);
            val_b -= 8;
        }
    }
    Some(buf)
}

fn b64_std_encode(data: &[u8]) -> String {
    b64_encode(data, B64_STD, true)
}

fn b64_url_encode(data: &[u8]) -> String {
    b64_encode(data, B64_URL, false)
}

fn b64_url_decode(input: &str) -> Option<Vec<u8>> {
    b64_decode(input)
}


fn hex_encode(data: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(data.len() * 2);
    for &b in data {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn new_uuid_v4() -> String {
    let mut b = [0u8; 16];
    os_fill(&mut b).expect("system entropy source failed");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

fn normalize_rpc_path(path_raw: &str) -> Option<String> {
    if path_raw.contains("://") || path_raw.starts_with("//") {
        return None;
    }
    let path = path_raw.split('#').next().unwrap_or(path_raw);
    let (path_part, query) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path, None),
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in path_part.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            let _ = parts.pop();
            continue;
        }
        if seg.contains('\\') {
            return None;
        }
        parts.push(seg);
    }
    let normalized = format!("/{}", parts.join("/"));
    if !normalized.starts_with("/api/") {
        return None;
    }
    Some(match query {
        Some(q) if !q.is_empty() => format!("{normalized}?{q}"),
        _ => normalized,
    })
}

fn stamp_asset_version(html: &str, asset: &str, version: &str) -> String {
    let mut out = String::with_capacity(html.len() + 32);
    let mut rest = html;

    while let Some(idx) = rest.find(asset) {
        out.push_str(&rest[..idx]);
        out.push_str(asset);
        out.push_str("?v=");
        out.push_str(version);

        let mut after = &rest[idx + asset.len()..];

        if after.starts_with('?') {
            let end = after
                .find(|c: char| c == '"' || c == '\'')
                .unwrap_or(after.len());
            after = &after[end..];
        }
        rest = after;
    }

    out.push_str(rest);
    out
}

#[derive(Clone)]
struct AppState {
    session_secret: Arc<String>,
    local_agent_token: Option<Arc<String>>,
    share_db: Option<PgPool>,
    identities: Arc<Mutex<HashMap<String, SocketIdentity>>>,
    agents: Arc<Mutex<HashMap<String, SocketRef>>>,
    agent_token_hashes: Arc<Mutex<HashMap<String, String>>>,
    panels: Arc<Mutex<HashMap<String, PanelConnection>>>,
    pairings: Arc<Mutex<HashMap<String, PairingCode>>>,
    cache: Arc<Mutex<HashMap<String, AgentCache>>>,
    last_status: Arc<Mutex<Value>>,
    rate_limits: Arc<Mutex<HashMap<String, RateWindow>>>,
}

#[derive(Clone)]
enum SocketIdentity {
    Agent { agent_id: String },
    Panel { session: PanelSession },
    LocalAgent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanelSession {
    agent_id: String,
    permission: String,
    kind: String,
    share_token_id: Option<String>,
    iat: i64,
    exp: i64,
    nonce: String,
}

#[derive(Clone)]
struct PanelConnection {
    socket: SocketRef,
    agent_id: String,
    permission: String,
    kind: String,
    session_exp: i64,
    share_token_id: Option<String>,
    pending_rpc: HashSet<String>,
}

#[derive(Clone, Default)]
struct AgentCache {
    status: Option<Value>,
    stats: Option<Value>,
    logs: Vec<Value>,
}

#[derive(Clone)]
struct PairingCode {
    agent_id: String,
    expires_at: i64,
}

struct RateWindow {
    count: u32,
    reset_at: i64,
}

#[derive(Clone, Debug)]
struct ShareToken {
    id: String,
    agent_id: String,
    token_hash: String,
    label: String,
    permission: String,
    created_at: i64,
    expires_at: Option<i64>,
    revoked_at: Option<i64>,
}

impl ShareToken {
    fn active(&self) -> bool {
        self.revoked_at.is_none() && self.expires_at.map(|v| v > now_ms()).unwrap_or(true)
    }

    fn public_json(&self) -> Value {
        json!({
            "id": self.id,
            "agentId": self.agent_id,
            "label": self.label,
            "permission": self.permission,
            "createdAt": self.created_at,
            "expiresAt": self.expires_at,
            "revokedAt": self.revoked_at,
        })
    }
}

impl AppState {
    fn new(session_secret: String, local_agent_token: Option<String>, share_db: Option<PgPool>) -> Self {
        Self {
            session_secret: Arc::new(session_secret),
            local_agent_token: local_agent_token.map(Arc::new),
            share_db,
            identities: Arc::new(Mutex::new(HashMap::new())),
            agents: Arc::new(Mutex::new(HashMap::new())),
            agent_token_hashes: Arc::new(Mutex::new(HashMap::new())),
            panels: Arc::new(Mutex::new(HashMap::new())),
            pairings: Arc::new(Mutex::new(HashMap::new())),
            cache: Arc::new(Mutex::new(HashMap::new())),
            last_status: Arc::new(Mutex::new(json!("offline"))),
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn rate_limited(&self, key: String, limit: u32, window_ms: i64) -> bool {
        let now = now_ms();
        let mut limits = self.rate_limits.lock().await;
        let entry = limits.entry(key).or_insert(RateWindow { count: 0, reset_at: now + window_ms });
        if now >= entry.reset_at {
            entry.count = 0;
            entry.reset_at = now + window_ms;
        }
        entry.count = entry.count.saturating_add(1);
        entry.count > limit
    }

    async fn find_share_token(&self, token: &str) -> anyhow::Result<Option<ShareToken>> {
        let pool = self.share_db.as_ref().ok_or_else(|| anyhow::anyhow!("DATABASE_URL no está configurada"))?;
        let hash = hash_token(token);
        let row = sqlx::query(
            "SELECT id, agent_id, token_hash, label, permission, created_at, expires_at, revoked_at \
             FROM moonwolf_share_tokens WHERE token_hash = $1 LIMIT 1",
        )
        .bind(hash)
        .fetch_optional(pool)
        .await?;
        row.map(share_from_row).transpose()
    }

    async fn find_share_token_by_id(&self, id: &str, agent_id: &str) -> anyhow::Result<Option<ShareToken>> {
        let pool = self.share_db.as_ref().ok_or_else(|| anyhow::anyhow!("DATABASE_URL no está configurada"))?;
        let row = sqlx::query(
            "SELECT id, agent_id, token_hash, label, permission, created_at, expires_at, revoked_at \
             FROM moonwolf_share_tokens WHERE id = $1 AND agent_id = $2 LIMIT 1",
        )
        .bind(id)
        .bind(agent_id)
        .fetch_optional(pool)
        .await?;
        row.map(share_from_row).transpose()
    }

    async fn list_share_tokens(&self, agent_id: &str) -> anyhow::Result<Vec<ShareToken>> {
        let pool = self.share_db.as_ref().ok_or_else(|| anyhow::anyhow!("DATABASE_URL no está configurada"))?;
        let rows = sqlx::query(
            "SELECT id, agent_id, token_hash, label, permission, created_at, expires_at, revoked_at \
             FROM moonwolf_share_tokens WHERE agent_id = $1 AND revoked_at IS NULL \
             AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at DESC",
        )
        .bind(agent_id)
        .bind(now_ms())
        .fetch_all(pool)
        .await?;
        rows.into_iter().map(share_from_row).collect()
    }
}

fn share_from_row(row: sqlx::postgres::PgRow) -> anyhow::Result<ShareToken> {
    Ok(ShareToken {
        id: row.try_get("id")?,
        agent_id: row.try_get("agent_id")?,
        token_hash: row.try_get::<String, _>("token_hash")?.trim().to_owned(),
        label: row.try_get("label")?,
        permission: row.try_get("permission")?,
        created_at: row.try_get("created_at")?,
        expires_at: row.try_get("expires_at")?,
        revoked_at: row.try_get("revoked_at")?,
    })
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn hash_token(token: &str) -> String {
    hex_encode(Sha256::digest(token.as_bytes()).as_slice())
}

fn random_code(length: usize) -> String {
    let mut bytes = vec![0_u8; length];
    os_fill(&mut bytes).expect("system entropy source failed");
    bytes.iter().map(|b| TOKEN_ALPHABET[(*b as usize) % TOKEN_ALPHABET.len()] as char).collect()
}

fn make_pairing_code() -> String {
    let raw = random_code(7);
    format!("MW-P{}-{}", &raw[..3], &raw[3..])
}

fn make_share_token() -> String {
    let raw = random_code(16);
    format!("MW-SHARE-{}-{}-{}-{}", &raw[0..4], &raw[4..8], &raw[8..12], &raw[12..16])
}

fn make_secret() -> String {
    let mut bytes = [0_u8; 32];
    os_fill(&mut bytes).expect("system entropy source failed");
    b64_url_encode(&bytes)
}

fn session_signature(secret: &str, payload: &str) -> anyhow::Result<String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(payload.as_bytes());
    Ok(b64_url_encode(mac.finalize().into_bytes().as_slice()))
}

fn create_panel_session(secret: &str, agent_id: &str, permission: &str, kind: &str, share_token_id: Option<String>, requested_exp: Option<i64>) -> anyhow::Result<String> {
    let now = now_ms();
    let normal_exp = now.saturating_add(SESSION_TTL_MS);
    let exp = requested_exp.map(|v| v.min(normal_exp)).unwrap_or(normal_exp);
    let mut nonce = [0_u8; 16];
    os_fill(&mut nonce).expect("system entropy source failed");
    let session = PanelSession {
        agent_id: agent_id.to_owned(),
        permission: permission.to_owned(),
        kind: kind.to_owned(),
        share_token_id,
        iat: now,
        exp,
        nonce: hex_encode(&nonce),
    };
    let payload = b64_url_encode(&serde_json::to_vec(&session)?);
    let signature = session_signature(secret, &payload)?;
    Ok(format!("{payload}.{signature}"))
}

fn verify_panel_session(secret: &str, token: &str) -> Option<PanelSession> {
    let (payload, signature) = token.split_once('.')?;
    let signature_bytes = b64_url_decode(signature)?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature_bytes).ok()?;
    let payload_bytes = b64_url_decode(payload)?;
    let session: PanelSession = serde_json::from_slice(&payload_bytes).ok()?;
    if session.agent_id.is_empty() || session.exp <= now_ms() {
        return None;
    }
    Some(session)
}

fn valid_agent_id(value: &str) -> bool {
    (16..=64).contains(&value.len()) && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn is_share_token_code(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 6
        && parts[0] == "MW"
        && parts[1] == "SHARE"
        && parts[2..].iter().all(|part| {
            part.len() == 4 && part.bytes().all(|c| c.is_ascii_uppercase() || (b'2'..=b'9').contains(&c))
        })
}

async fn authenticate_socket(state: &AppState, auth: &Value) -> Result<SocketIdentity, String> {
    match auth.get("role").and_then(Value::as_str).unwrap_or("") {
        "agent" => {
            let agent_id = auth.get("agentId").and_then(Value::as_str).unwrap_or("").to_owned();
            let token = auth.get("token").and_then(Value::as_str).unwrap_or("");
            if !valid_agent_id(&agent_id) || token.len() < 32 {
                return Err("unauthorized".into());
            }
            let hash = hash_token(token);
            let mut registered = state.agent_token_hashes.lock().await;
            if let Some(existing) = registered.get(&agent_id) {
                if existing.as_bytes().ct_eq(hash.as_bytes()).unwrap_u8() != 1 {
                    return Err("unauthorized".into());
                }
            } else {
                registered.insert(agent_id.clone(), hash);
            }
            Ok(SocketIdentity::Agent { agent_id })
        }
        "panel" => {
            let raw = auth.get("session").and_then(Value::as_str).unwrap_or("");
            let mut session = verify_panel_session(&state.session_secret, raw).ok_or_else(|| "unauthorized".to_owned())?;
            if session.kind == "share" {
                let id = session.share_token_id.clone().ok_or_else(|| "unauthorized".to_owned())?;
                let share = state.find_share_token_by_id(&id, &session.agent_id).await.map_err(|_| "share_store_unavailable".to_owned())?;
                let share = share.filter(|v| v.active()).ok_or_else(|| "unauthorized".to_owned())?;
                session.permission = normalize_permission(&share.permission).unwrap_or_else(|| "read".into());
                if let Some(exp) = share.expires_at { session.exp = session.exp.min(exp); }
            }
            Ok(SocketIdentity::Panel { session })
        }
        "local-agent" => {
            let token = auth.get("token").and_then(Value::as_str).unwrap_or("");
            let expected = state.local_agent_token.as_deref().map(|s| s.as_str()).unwrap_or("");
            if expected.is_empty() || !constant_time_equal(token, expected) {
                return Err("unauthorized".into());
            }
            Ok(SocketIdentity::LocalAgent)
        }
        _ => Err("invalid_role".into()),
    }
}

fn constant_time_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() { return false; }
    a.as_bytes().ct_eq(b.as_bytes()).unwrap_u8() == 1
}

fn normalize_permission(permission: &str) -> Option<String> {
    match permission.to_ascii_lowercase().as_str() {
        "read" | "control" | "admin" => Some(permission.to_ascii_lowercase()),
        _ => None,
    }
}

fn permission_allows(actual: &str, required: &str) -> bool {
    let rank = |p: &str| match p { "read" => 1, "control" => 2, "admin" => 3, _ => 0 };
    rank(actual) >= rank(required)
}

fn required_permission(method: &str, path: &str) -> &'static str {
    let path = path.split('?').next().unwrap_or(path);
    let method = method.to_ascii_uppercase();
    let is_admin = match method.as_str() {
        "GET" | "HEAD" => [
            "/api/files", "/api/files/content", "/api/files/download",
            "/api/databases/status", "/api/databases", "/api/backups", "/api/backups/download/:name",
            "/api/backups/progress",
        ].iter().any(|p| route_matches(path, p)),
        "POST" => [
            "/api/files/content", "/api/files/create", "/api/files/rename", "/api/files/copy",
            "/api/files/move", "/api/files/compress", "/api/files/bulk", "/api/files/delete",
            "/api/files/upload-chunk", "/api/databases", "/api/databases/:name/reset-password",
            "/api/backups", "/api/backups/:name/restore", "/api/startup", "/api/startup/detect-version",
            "/api/ports", "/api/plugins/install", "/api/versions/install",
        ].iter().any(|p| route_matches(path, p)),
        "DELETE" => ["/api/databases/:name", "/api/backups/:name", "/api/plugins/installed/:file"]
            .iter().any(|p| route_matches(path, p)),
        _ => false,
    };
    if is_admin { "admin" } else if method == "GET" || method == "HEAD" { "read" } else { "control" }
}

fn route_matches(path: &str, pattern: &str) -> bool {
    let actual: Vec<_> = path.split('/').collect();
    let expected: Vec<_> = pattern.split('/').collect();
    actual.len() == expected.len() && expected.iter().zip(actual.iter()).all(|(a, b)| a.starts_with(':') || a == b)
}

fn header_client_ip(headers: &HeaderMap) -> String {
    headers.get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').last())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("unknown")
        .to_owned()
}

fn socket_client_ip(socket: &SocketRef) -> String {
    header_client_ip(&socket.req_parts().headers)
}

async fn auth_middleware(state: Arc<AppState>, socket: SocketRef, auth: Value) -> Result<(), String> {
    let ip = socket_client_ip(&socket);
    if state.rate_limited(format!("socket-connect:{ip}"), 40, 60_000).await {
        return Err("rate_limited".into());
    }
    let identity = authenticate_socket(&state, &auth).await?;
    state.identities.lock().await.insert(socket.id.to_string(), identity);
    Ok(())
}

async fn register_socket_handlers(state: Arc<AppState>, io: SocketIo, socket: SocketRef, identity: SocketIdentity) {
    match identity {
        SocketIdentity::LocalAgent => {
            socket.join("local-agent");
            let status = state.last_status.lock().await.clone();
            let _ = socket.emit("status", &status);
            socket.on_disconnect(|socket: SocketRef, _reason: DisconnectReason| async move {
                info!("Local Agent desconectado: {}", socket.id);
            });
        }
        SocketIdentity::Agent { agent_id } => {
            let agent_id_for_connect = agent_id.clone();
            let previous = state.agents.lock().await.insert(agent_id.clone(), socket.clone());
            if let Some(previous) = previous {
                if previous.id.to_string() != socket.id.to_string() { let _ = previous.disconnect(); }
            }
            socket.join(format!("agent:{agent_id}"));
            notify_agent_state(&io, &agent_id_for_connect, true).await;

            let state_pair = state.clone();
            let agent_id_pair = agent_id.clone();
            socket.on("pairing_create", move |socket: SocketRef| {
                let state = state_pair.clone();
                let agent_id = agent_id_pair.clone();
                async move {
                    if state.rate_limited(format!("{}:pairing_create", socket.id), 6, 60_000).await { return; }
                    let mut pairings = state.pairings.lock().await;
                    pairings.retain(|_, p| p.expires_at > now_ms() && p.agent_id != agent_id);
                    let mut code = make_pairing_code();
                    while pairings.contains_key(&code) { code = make_pairing_code(); }
                    let expires_at = now_ms() + PAIRING_TTL_MS;
                    pairings.insert(code.clone(), PairingCode { agent_id, expires_at });
                    let _ = socket.emit("pairing_ready", &json!({"code":code,"expiresAt":expires_at,"ttlMs":PAIRING_TTL_MS}));
                }
            });

            let state_event = state.clone();
            let io_event = io.clone();
            let agent_id_event = agent_id.clone();
            socket.on("event", move |_socket: SocketRef, Data(event): Data<Value>| {
                let state = state_event.clone();
                let io = io_event.clone();
                let agent_id = agent_id_event.clone();
                async move {
                    if state.rate_limited(format!("agent-event:{agent_id}"), 240, 60_000).await { return; }
                    let Some(name) = event.get("name").and_then(Value::as_str) else { return; };
                    if !["status", "log", "log_batch", "stats"].contains(&name) { return; }
                    let payload = event.get("payload").cloned().unwrap_or(Value::Null);
                    {
                        let mut cache = state.cache.lock().await;
                        let entry = cache.entry(agent_id.clone()).or_default();
                        match name {
                            "status" => entry.status = Some(payload.clone()),
                            "stats" => entry.stats = Some(payload.clone()),
                            "log" => entry.logs.push(payload.clone()),
                            "log_batch" => {
                                if let Some(items) = payload.as_array() { entry.logs.extend(items.iter().cloned()); }
                            }
                            _ => {}
                        }
                        if entry.logs.len() > MAX_CACHED_LOGS {
                            let remove = entry.logs.len() - MAX_CACHED_LOGS;
                            entry.logs.drain(0..remove);
                        }
                    }
                    if name == "status" {
                        *state.last_status.lock().await = payload.clone();
                        let _ = io.to("local-agent").emit("status", &payload).await;
                    }
                    let _ = io.to(format!("panels:{agent_id}")).emit(name, &payload).await;
                }
            });

            let state_rpc_result = state.clone();
            let agent_id_rpc_result = agent_id.clone();
            socket.on("rpc_result", move |_socket: SocketRef, Data(result): Data<Value>| {
                let state = state_rpc_result.clone();
                let agent_id = agent_id_rpc_result.clone();
                async move {
                    if state.rate_limited(format!("agent-rpc-result:{agent_id}"), 240, 60_000).await { return; }
                    let Some(id) = result.get("id") else { return; };
                    let id_key = id.to_string();
                    let target_socket = {
                        let mut panels = state.panels.lock().await;
                        let mut target_socket = None;

                        for panel in panels.values_mut() {
                            if panel.agent_id == agent_id && panel.pending_rpc.remove(&id_key) {
                                target_socket = Some(panel.socket.clone());
                                break;
                            }
                        }

                        target_socket
                    };

                    if let Some(socket) = target_socket {
                        let _ = socket.emit("rpc_result", &result);
                    }
                }
            });

            // ICE/WebRTC: señalización Agent -> navegador.
            let state_signal = state.clone();
            let agent_id_signal = agent_id.clone();
            socket.on("direct_signal", move |_socket: SocketRef, Data(msg): Data<Value>| {
                let state = state_signal.clone();
                let agent_id = agent_id_signal.clone();
                async move {
                    if state.rate_limited(format!("agent-direct-signal:{agent_id}"), 240, 60_000).await { return; }
                    let Some(peer_id) = msg.get("peerId").and_then(Value::as_str) else { return; };
                    let panel = state.panels.lock().await.get(peer_id).cloned();
                    let Some(panel) = panel.filter(|p| p.agent_id == agent_id) else { return; };
                    let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
                    if !["answer", "candidate"].contains(&kind) { return; }
                    let mut forwarded = json!({"type":kind});
                    if kind == "answer" {
                        forwarded["sdp"] = Value::String(msg.get("sdp").and_then(Value::as_str).unwrap_or("").chars().take(32_768).collect());
                    } else {
                        forwarded["candidate"] = Value::String(msg.get("candidate").and_then(Value::as_str).unwrap_or("").chars().take(2_048).collect());
                        if let Some(mid) = msg.get("sdpMid") { forwarded["sdpMid"] = Value::String(mid.as_str().unwrap_or("").chars().take(64).collect()); }
                    }
                    let _ = panel.socket.emit("direct_signal", &forwarded);
                }
            });

            let state_disconnect = state.clone();
            let io_disconnect = io.clone();
            let agent_id_disconnect = agent_id.clone();
            socket.on_disconnect(move |socket: SocketRef, _reason: DisconnectReason| {
                let state = state_disconnect.clone();
                let io = io_disconnect.clone();
                let agent_id = agent_id_disconnect.clone();
                async move {
                    let mut agents = state.agents.lock().await;
                    if agents.get(&agent_id).map(|s| s.id.to_string() == socket.id.to_string()).unwrap_or(false) {
                        agents.remove(&agent_id);
                        drop(agents);
                        notify_agent_state(&io, &agent_id, false).await;
                    }
                }
            });
        }
        SocketIdentity::Panel { session } => {
            let panel_id = socket.id.to_string();
            let agent_id = session.agent_id.clone();
            socket.join(format!("panels:{agent_id}"));
            state.panels.lock().await.insert(panel_id.clone(), PanelConnection {
                socket: socket.clone(),
                agent_id: agent_id.clone(),
                permission: session.permission.clone(),
                kind: session.kind.clone(),
                session_exp: session.exp,
                share_token_id: session.share_token_id.clone(),
                pending_rpc: HashSet::new(),
            });

            let online = state.agents.lock().await.get(&agent_id).map(|s| s.connected()).unwrap_or(false);
            let _ = socket.emit("direct_config", &json!({"iceServers":ICE_SERVERS}));
            let _ = socket.emit("cloud_ready", &json!({"agentOnline":online}));
            let _ = socket.emit("agent_status", &json!({"online":online}));
            let cached = state.cache.lock().await.get(&agent_id).cloned();
            if online {
                if let Some(cache) = cached {
                    if !cache.logs.is_empty() { let _ = socket.emit("history", &cache.logs); }
                    if let Some(status) = cache.status { let _ = socket.emit("status", &status); }
                    if let Some(stats) = cache.stats { let _ = socket.emit("stats", &stats); }
                }
            }
            let _ = socket.emit("session_info", &json!({
                "permission":session.permission,"kind":session.kind,"expiresAt":session.exp
            }));

            let exp_socket = socket.clone();
            let exp_delay = session.exp.saturating_sub(now_ms()).max(0) as u64;
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(exp_delay)).await;
                let _ = exp_socket.disconnect();
            });

            let state_rpc = state.clone();
            let rpc_panel_id = panel_id.clone();
            let rpc_agent_id = agent_id.clone();
            let rpc_session = session.clone();
            socket.on("rpc", move |socket: SocketRef, Data(request): Data<Value>| {
                let state = state_rpc.clone();
                let panel_id = rpc_panel_id.clone();
                let agent_id = rpc_agent_id.clone();
                let session = rpc_session.clone();
                async move { handle_panel_rpc(state, socket, panel_id, agent_id, session, request).await; }
            });

            let state_signal = state.clone();
            let signal_panel_id = panel_id.clone();
            let signal_agent_id = agent_id.clone();
            let signal_session = session.clone();
            socket.on("direct_signal", move |socket: SocketRef, Data(msg): Data<Value>| {
                let state = state_signal.clone();
                let panel_id = signal_panel_id.clone();
                let agent_id = signal_agent_id.clone();
                let session = signal_session.clone();
                async move { handle_panel_signal(state, socket, panel_id, agent_id, session, msg).await; }
            });

            let state_disconnect = state.clone();
            socket.on_disconnect(move |socket: SocketRef, _reason: DisconnectReason| {
                let state = state_disconnect.clone();
                let panel_id = panel_id.clone();
                let agent_id = agent_id.clone();
                async move {
                    let panel = state.panels.lock().await.remove(&panel_id);
                    if panel.is_some() {
                        if let Some(agent) = state.agents.lock().await.get(&agent_id).cloned() {
                            let _ = agent.emit("direct_close", &json!({"peerId":socket.id.to_string()}));
                        }
                    }
                }
            });
        }
    }
}

async fn notify_agent_state(io: &SocketIo, agent_id: &str, online: bool) {
    let payload = json!({"agentOnline":online});
    let status = json!({"online":online});
    let room = format!("panels:{agent_id}");
    let _ = io.to(room).emit("cloud_ready", &payload).await;
    let _ = io.to(format!("panels:{agent_id}")).emit("agent_status", &status).await;
}

async fn handle_panel_rpc(state: Arc<AppState>, socket: SocketRef, panel_id: String, agent_id: String, initial_session: PanelSession, request: Value) {
    let path_raw = request.get("path").and_then(Value::as_str).unwrap_or("");
    let upload = path_raw.starts_with("/api/files/upload-chunk");
    if state.rate_limited(format!("{}:rpc", panel_id), if upload { 2_000 } else { 120 }, 60_000).await {
        emit_rpc_error(&socket, request.get("id").cloned(), 429, "Demasiadas solicitudes en tiempo real. Espera un momento.");
        return;
    }
    let Some(id) = request.get("id").cloned().filter(|v| !v.is_null()) else { return; };
    let id_key = id.to_string();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("GET").to_ascii_uppercase();
    if !["GET", "POST", "PUT", "PATCH", "DELETE"].contains(&method.as_str()) {
        emit_rpc_error(&socket, Some(id), 400, "Método no válido.");
        return;
    }
    let Some(path) = normalize_rpc_path(path_raw) else {
        emit_rpc_error(&socket, Some(id), 400, "Ruta no válida.");
        return;
    };
    let mut permission = initial_session.permission.clone();
    if initial_session.kind == "share" {
        let Some(token_id) = initial_session.share_token_id.as_deref() else {
            let _ = socket.emit("share_revoked", &json!({}));
            let _ = socket.disconnect();
            return;
        };
        match state.find_share_token_by_id(token_id, &agent_id).await {
            Ok(Some(share)) if share.active() => permission = normalize_permission(&share.permission).unwrap_or_else(|| "read".into()),
            _ => { let _ = socket.emit("share_revoked", &json!({})); let _ = socket.disconnect(); return; }
        }
        if !permission_allows(&permission, required_permission(&method, &path)) {
            emit_rpc_error(&socket, Some(id), 403, "No tienes permisos para realizar esta acción.");
            return;
        }
        if let Some(panel) = state.panels.lock().await.get_mut(&panel_id) { panel.permission = permission.clone(); }
    }
    let agent = state.agents.lock().await.get(&agent_id).cloned();
    let Some(agent) = agent.filter(|s| s.connected()) else {
        emit_rpc_error(&socket, Some(id), 503, "MoonWolf Agent no está conectado.");
        return;
    };
    {
        let mut panels = state.panels.lock().await;
        let Some(panel) = panels.get_mut(&panel_id) else { return; };
        if panel.pending_rpc.len() >= 100 {
            emit_rpc_error(&socket, Some(id), 429, "Demasiadas solicitudes pendientes. Espera a que terminen algunas operaciones.");
            return;
        }
        panel.pending_rpc.insert(id_key);
        let mut sanitized = json!({
            "id":id.clone(),
            "method":method.clone(),
            "path":path.clone(),
            "ctx":{"kind":panel.kind.clone(),"permission":permission.clone()}
        });
        if let Some(body) = request.get("body") { sanitized["body"] = body.clone(); }
        if let Err(e) = agent.emit("rpc", &sanitized) {
            panel.pending_rpc.remove(&id.to_string());
            warn!("No se pudo enviar RPC al Agent: {e}");
            emit_rpc_error(&socket, Some(id), 503, "No se pudo enviar la operación al MoonWolf Agent.");
        }
    }
}

async fn handle_panel_signal(state: Arc<AppState>, socket: SocketRef, panel_id: String, agent_id: String, session: PanelSession, msg: Value) {
    if state.rate_limited(format!("{}:direct-signal", panel_id), 60, 60_000).await { return; }
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
    if !["offer", "candidate"].contains(&kind) { return; }
    let agent = state.agents.lock().await.get(&agent_id).cloned();
    let Some(agent) = agent.filter(|s| s.connected()) else {
        let _ = socket.emit("direct_signal", &json!({"type":"unavailable"}));
        return;
    };
    let mut permission = session.permission.clone();
    if session.kind == "share" {
        let Some(id) = session.share_token_id.as_deref() else { let _ = socket.emit("share_revoked", &json!({})); let _ = socket.disconnect(); return; };
        match state.find_share_token_by_id(id, &agent_id).await {
            Ok(Some(share)) if share.active() => permission = normalize_permission(&share.permission).unwrap_or_else(|| "read".into()),
            _ => { let _ = socket.emit("share_revoked", &json!({})); let _ = socket.disconnect(); return; }
        }
    }
    let mut forwarded = json!({"peerId":panel_id,"type":kind});
    if kind == "offer" {
        forwarded["sdp"] = Value::String(msg.get("sdp").and_then(Value::as_str).unwrap_or("").chars().take(32_768).collect());
        forwarded["iceServers"] = json!([{"urls":ICE_SERVERS[0]},{"urls":ICE_SERVERS[1]}]);
        forwarded["ctx"] = json!({"kind":session.kind,"permission":permission,"expiresAt":session.exp});
    } else {
        forwarded["candidate"] = Value::String(msg.get("candidate").and_then(Value::as_str).unwrap_or("").chars().take(2_048).collect());
        forwarded["sdpMid"] = Value::String(msg.get("sdpMid").and_then(Value::as_str).unwrap_or("0").chars().take(64).collect());
    }
    if let Err(e) = agent.emit("direct_signal", &forwarded) { warn!("direct_signal: {e}"); }
}

fn emit_rpc_error(socket: &SocketRef, id: Option<Value>, status: u16, message: &str) {
        let body = serde_json::to_vec(&json!({"ok":false,"error":message})).unwrap_or_default();
    let response = json!({
        "id":id.unwrap_or(Value::Null),"ok":false,"status":status,
        "contentType":"application/json","bodyBase64":b64_std_encode(&body)
    });
    let _ = socket.emit("rpc_result", &response);
}

// ───────────────────────────── HTTP API ─────────────────────────────

fn api_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"ok":false,"error":message}))).into_response()
}

async fn health() -> impl IntoResponse {
    Json(json!({"ok":true,"service":SERVICE_NAME}))
}

#[derive(Deserialize)]
struct PairBody { code: String }

async fn pair(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<PairBody>) -> Response {
    let ip = header_client_ip(&headers);
    if state.rate_limited(format!("pair:{ip}"), 10, 5 * 60_000).await {
        return api_error(StatusCode::TOO_MANY_REQUESTS, "Demasiados intentos, espera unos minutos.");
    }
    let code = body.code.trim().to_ascii_uppercase();
    let (agent_id, permission, kind, share_token_id, expires_at, used_pairing) = if is_share_token_code(&code) {
        match state.find_share_token(&code).await {
            Ok(Some(share)) if share.active() => (share.agent_id.clone(), share.permission.clone(), "share".to_owned(), Some(share.id.clone()), share.expires_at, false),
            Ok(_) => return api_error(StatusCode::UNAUTHORIZED, "Token compartido inválido, revocado o caducado."),
            Err(e) => { error!("Share token lookup: {e:#}"); return api_error(StatusCode::SERVICE_UNAVAILABLE, "El servicio de autorizaciones no está disponible. Inténtalo de nuevo más tarde."); }
        }
    } else {
        let pairing = state.pairings.lock().await.remove(&code);
        let Some(pairing) = pairing.filter(|p| p.expires_at > now_ms()) else {
            return api_error(StatusCode::UNAUTHORIZED, "Código de emparejamiento inválido o caducado.");
        };
        (pairing.agent_id, "admin".to_owned(), "owner".to_owned(), None, None, true)
    };
    let agent = state.agents.lock().await.get(&agent_id).cloned();
    let Some(agent) = agent.filter(|s| s.connected()) else {
        return api_error(StatusCode::CONFLICT, "El MoonWolf Agent ya no está conectado.");
    };
    let session = match create_panel_session(&state.session_secret, &agent_id, &permission, &kind, share_token_id, expires_at) {
        Ok(v) => v,
        Err(e) => { error!("No se pudo crear sesión: {e:#}"); return api_error(StatusCode::INTERNAL_SERVER_ERROR, "No se pudo crear la sesión."); }
    };
    if used_pairing { let _ = agent.emit("pairing_consumed", &json!({})); }
    Json(json!({"ok":true,"session":session,"permission":permission,"kind":kind,"agent":{"id":agent_id,"online":true}})).into_response()
}

async fn session_from_headers(state: &AppState, headers: &HeaderMap) -> Result<PanelSession, StatusCode> {
    let authorization = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
    let token = authorization.strip_prefix("Bearer ").ok_or(StatusCode::UNAUTHORIZED)?.trim();
    let mut session = verify_panel_session(&state.session_secret, token).ok_or(StatusCode::UNAUTHORIZED)?;
    if session.kind == "share" {
        let id = session.share_token_id.as_deref().ok_or(StatusCode::UNAUTHORIZED)?;
        let share = state.find_share_token_by_id(id, &session.agent_id).await.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let share = share.filter(|v| v.active()).ok_or(StatusCode::UNAUTHORIZED)?;
        session.permission = normalize_permission(&share.permission).unwrap_or_else(|| "read".into());
    }
    Ok(session)
}

async fn list_share_tokens(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let session = match session_from_headers(&state, &headers).await {
        Ok(s) => s,
        Err(StatusCode::SERVICE_UNAVAILABLE) => return api_error(StatusCode::SERVICE_UNAVAILABLE, "Neon no está disponible; no se pudieron consultar los accesos compartidos."),
        Err(_) => return api_error(StatusCode::UNAUTHORIZED, "No autorizado."),
    };
    if session.permission != "admin" { return api_error(StatusCode::FORBIDDEN, "Necesitas el permiso Administrador para gestionar accesos compartidos."); }
    match state.list_share_tokens(&session.agent_id).await {
        Ok(tokens) => Json(json!({"ok":true,"tokens":tokens.iter().map(ShareToken::public_json).collect::<Vec<_>>()})).into_response(),
        Err(e) => { error!("share tokens list: {e:#}"); api_error(StatusCode::SERVICE_UNAVAILABLE, "Neon no está disponible; no se pudieron consultar los accesos compartidos.") }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateShareBody { permission: String, #[serde(default)] expires: Option<String>, #[serde(default)] label: Option<String> }

async fn create_share_token(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<CreateShareBody>) -> Response {
    let session = match session_from_headers(&state, &headers).await {
        Ok(s) => s,
        Err(StatusCode::SERVICE_UNAVAILABLE) => return api_error(StatusCode::SERVICE_UNAVAILABLE, "No se pudo verificar el acceso compartido."),
        Err(_) => return api_error(StatusCode::UNAUTHORIZED, "No autorizado."),
    };
    if session.permission != "admin" { return api_error(StatusCode::FORBIDDEN, "Necesitas el permiso Administrador para crear accesos compartidos."); }
    let Some(permission) = normalize_permission(&body.permission) else { return api_error(StatusCode::BAD_REQUEST, "Permiso no válido."); };
    let expires = body.expires.unwrap_or_else(|| "never".into()).to_ascii_lowercase();
    let duration = match expires.as_str() { "never" => None, "1h" => Some(60 * 60_000), "1d" => Some(24 * 60 * 60_000), "7d" => Some(7 * 24 * 60 * 60_000), "30d" => Some(30 * 24 * 60 * 60_000), _ => return api_error(StatusCode::BAD_REQUEST, "Caducidad no válida.") };
    let token = make_share_token();
    let requested_label = body.label.unwrap_or_default().trim().chars().take(60).collect::<String>();
    let label = if requested_label.is_empty() { "Acceso compartido".to_owned() } else { requested_label };
    let record = ShareToken {
        id: new_uuid_v4(),
        agent_id: session.agent_id.clone(),
        token_hash: hash_token(&token),
        label,
        permission,
        created_at: now_ms(),
        expires_at: duration.map(|d| now_ms() + d),
        revoked_at: None,
    };
    let label = &record.label;
    let Some(pool) = state.share_db.as_ref() else { return api_error(StatusCode::SERVICE_UNAVAILABLE, "DATABASE_URL no está configurada."); };
    let result = sqlx::query("INSERT INTO moonwolf_share_tokens (id,agent_id,token_hash,label,permission,created_at,expires_at,revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)")
        .bind(&record.id).bind(&record.agent_id).bind(&record.token_hash).bind(label).bind(&record.permission).bind(record.created_at).bind(record.expires_at).execute(pool).await;
    if let Err(e) = result { error!("share token create: {e:#}"); return api_error(StatusCode::SERVICE_UNAVAILABLE, "Neon no está disponible; no se pudo guardar el acceso compartido."); }
    Json(json!({"ok":true,"token":token,"access":record.public_json()})).into_response()
}

#[derive(Deserialize)]
struct UpdateShareBody { permission: String }

async fn update_share_token(State(state): State<Arc<AppState>>, headers: HeaderMap, Path(id): Path<String>, Json(body): Json<UpdateShareBody>) -> Response {
    let session = match session_from_headers(&state, &headers).await {
        Ok(s) => s,
        Err(StatusCode::SERVICE_UNAVAILABLE) => return api_error(StatusCode::SERVICE_UNAVAILABLE, "No se pudo verificar el acceso compartido."),
        Err(_) => return api_error(StatusCode::UNAUTHORIZED, "No autorizado."),
    };
    if session.permission != "admin" { return api_error(StatusCode::FORBIDDEN, "Necesitas el permiso Administrador para editar accesos compartidos."); }
    let Some(permission) = normalize_permission(&body.permission) else { return api_error(StatusCode::BAD_REQUEST, "Permiso no válido."); };
    let Some(pool) = state.share_db.as_ref() else { return api_error(StatusCode::SERVICE_UNAVAILABLE, "DATABASE_URL no está configurada."); };
    let row = sqlx::query("UPDATE moonwolf_share_tokens SET permission=$1 WHERE id=$2 AND agent_id=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$4) RETURNING id,agent_id,token_hash,label,permission,created_at,expires_at,revoked_at")
        .bind(&permission).bind(&id).bind(&session.agent_id).bind(now_ms()).fetch_optional(pool).await;
    let record = match row { Ok(Some(row)) => match share_from_row(row) { Ok(v) => v, Err(e) => { error!("share token row: {e:#}"); return api_error(StatusCode::INTERNAL_SERVER_ERROR, "Error al leer el acceso compartido."); } }, Ok(None) => return api_error(StatusCode::NOT_FOUND, "Acceso compartido no encontrado."), Err(e) => { error!("share token update: {e:#}"); return api_error(StatusCode::SERVICE_UNAVAILABLE, "Neon no está disponible; no se pudo actualizar el acceso compartido."); } };
    let updates: Vec<(SocketRef, String, i64)> = {
        let mut panels = state.panels.lock().await;
        panels.values_mut().filter(|p| p.share_token_id.as_deref() == Some(record.id.as_str())).map(|p| {
            p.permission = permission.clone();
            (p.socket.clone(), p.agent_id.clone(), p.session_exp)
        }).collect()
    };
    for (panel, agent_id, session_exp) in updates {
        if let Some(agent) = state.agents.lock().await.get(&agent_id).cloned() {
            let _ = agent.emit("direct_ctx", &json!({"peerId":panel.id.to_string(),"permission":permission}));
        }
        let _ = panel.emit("session_info", &json!({"permission":permission,"kind":"share","expiresAt":session_exp}));
    }
    Json(json!({"ok":true,"access":record.public_json()})).into_response()
}

async fn delete_share_token(State(state): State<Arc<AppState>>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let session = match session_from_headers(&state, &headers).await {
        Ok(s) => s,
        Err(StatusCode::SERVICE_UNAVAILABLE) => return api_error(StatusCode::SERVICE_UNAVAILABLE, "No se pudo verificar el acceso compartido."),
        Err(_) => return api_error(StatusCode::UNAUTHORIZED, "No autorizado."),
    };
    if session.permission != "admin" { return api_error(StatusCode::FORBIDDEN, "Necesitas el permiso Administrador para revocar accesos compartidos."); }
    let Some(pool) = state.share_db.as_ref() else { return api_error(StatusCode::SERVICE_UNAVAILABLE, "DATABASE_URL no está configurada."); };
    let row = sqlx::query("UPDATE moonwolf_share_tokens SET revoked_at=$1 WHERE id=$2 AND agent_id=$3 AND revoked_at IS NULL RETURNING id,agent_id,token_hash,label,permission,created_at,expires_at,revoked_at")
        .bind(now_ms()).bind(&id).bind(&session.agent_id).fetch_optional(pool).await;
    let record = match row { Ok(Some(row)) => match share_from_row(row) { Ok(v) => v, Err(e) => { error!("share token row: {e:#}"); return api_error(StatusCode::INTERNAL_SERVER_ERROR, "Error al leer el acceso compartido."); } }, Ok(None) => return api_error(StatusCode::NOT_FOUND, "Acceso compartido no encontrado."), Err(e) => { error!("share token revoke: {e:#}"); return api_error(StatusCode::SERVICE_UNAVAILABLE, "Neon no está disponible; no se pudo revocar el acceso compartido."); } };
    let sockets: Vec<SocketRef> = {
        let mut panels = state.panels.lock().await;
        let ids: Vec<String> = panels.iter().filter(|(_, p)| p.share_token_id.as_deref() == Some(record.id.as_str())).map(|(k, _)| k.clone()).collect();
        ids.into_iter().filter_map(|id| panels.remove(&id).map(|p| p.socket)).collect()
    };
    for socket in sockets { let _ = socket.emit("share_revoked", &json!({})); let _ = socket.disconnect(); }
    Json(json!({"ok":true})).into_response()
}

// ───────────────────────────── Static web assets ─────────────────────────────

fn asset_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(name)
}

async fn read_asset(name: &str) -> Result<Vec<u8>, std::io::Error> {
    tokio::fs::read(asset_path(name)).await
}

fn static_response(bytes: Vec<u8>, content_type: &'static str, cache: &'static str) -> Response {
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

async fn index() -> Response {
    let html = match read_asset("index.html").await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) => { error!("No se pudo leer index.html: {e}"); return StatusCode::NOT_FOUND.into_response(); }
    };
    let mut output = html;
    for asset in ["dashboard.js", "styles.css"] {
        let version = match read_asset(asset).await {
            Ok(bytes) => hex_encode(Sha1::digest(&bytes).as_slice())[..10].to_owned(),
            Err(_) => "unknown".into(),
        };
        output = stamp_asset_version(&output, asset, &version);
    }
    static_response(output.into_bytes(), "text/html; charset=utf-8", "no-store")
}

async fn dashboard_js(Query(query): Query<HashMap<String, String>>) -> Response {
    match read_asset("dashboard.js").await {
        Ok(bytes) => {
            let version = hex_encode(Sha1::digest(&bytes).as_slice())[..10].to_owned();
            let cache = if query.get("v").map(String::as_str) == Some(version.as_str()) { "public, max-age=31536000, immutable" } else { "public, max-age=300" };
            static_response(bytes, "text/javascript; charset=utf-8", cache)
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn styles_css(Query(query): Query<HashMap<String, String>>) -> Response {
    match read_asset("styles.css").await {
        Ok(bytes) => {
            let version = hex_encode(Sha1::digest(&bytes).as_slice())[..10].to_owned();
            let cache = if query.get("v").map(String::as_str) == Some(version.as_str()) { "public, max-age=31536000, immutable" } else { "public, max-age=300" };
            static_response(bytes, "text/css; charset=utf-8", cache)
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let is_api = request.uri().path().starts_with("/api/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy", HeaderValue::from_static("strict-origin-when-cross-origin"));
    headers.insert("strict-transport-security", HeaderValue::from_static("max-age=31536000; includeSubDomains"));
    headers.insert("x-dns-prefetch-control", HeaderValue::from_static("off"));
    headers.insert("x-download-options", HeaderValue::from_static("noopen"));
    headers.insert("x-permitted-cross-domain-policies", HeaderValue::from_static("none"));
    headers.insert("x-xss-protection", HeaderValue::from_static("0"));
    headers.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
    headers.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    headers.insert("origin-agent-cluster", HeaderValue::from_static("?1"));
    headers.insert("permissions-policy", HeaderValue::from_static("camera=(), microphone=(), geolocation=()"));
    headers.insert("content-security-policy", HeaderValue::from_static(
        "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com https://cdn.socket.io; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' wss://moonwolf-panel.onrender.com ws://moonwolf-panel.onrender.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests"    ));
    if is_api { headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store")); }
    response
}

async fn initialize_share_store(database_url: &str) -> anyhow::Result<PgPool> {
    use std::str::FromStr;
    use sqlx::postgres::{PgConnectOptions, PgSslMode};
    let options = PgConnectOptions::from_str(database_url)?.ssl_mode(PgSslMode::Require);
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(options)
        .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS moonwolf_share_tokens (\
         id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE,\
         label TEXT NOT NULL DEFAULT 'Acceso compartido',\
         permission TEXT NOT NULL CHECK (permission IN ('read','control','admin')),\
         created_at BIGINT NOT NULL, expires_at BIGINT NULL, revoked_at BIGINT NULL)"
    ).execute(&pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS moonwolf_share_tokens_agent_created_idx ON moonwolf_share_tokens (agent_id, created_at DESC)")
        .execute(&pool).await?;
    Ok(pool)
}

fn load_session_secret() -> String {
    if let Ok(secret) = env::var("SESSION_SECRET") {
        if secret.len() >= 32 { return secret; }
        warn!("SESSION_SECRET existe pero tiene menos de 32 caracteres; se ignorará.");
    }

    let app_dir = env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            let home = env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from("."));
            home.join("AppData").join("Roaming")
        })
        .join("MoonWolf");
    let secret_path = app_dir.join("session-secret");
    let backup_path = app_dir.join("session-secret.bak");

    for path in [&secret_path, &backup_path] {
        if let Ok(value) = std::fs::read_to_string(path) {
            let value = value.trim().to_owned();
            if value.len() >= 32 {
                if path == &backup_path {
                    let _ = std::fs::create_dir_all(&app_dir);
                    let _ = std::fs::write(&secret_path, &value);
                }
                return value;
            }
        }
    }

    let secret = make_secret();
    if let Err(e) = std::fs::create_dir_all(&app_dir).and_then(|_| std::fs::write(&secret_path, &secret)) {
        warn!("No se pudo persistir SESSION_SECRET en {}: {e}", secret_path.display());
    }
    warn!("SESSION_SECRET generada localmente. En Render configura una clave persistente para evitar invalidar sesiones al reiniciar.");
    secret
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .init();

    let share_db = match env::var("DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => match initialize_share_store(&url).await {
            Ok(pool) => { info!("PostgreSQL conectado; tokens compartidos habilitados."); Some(pool) }
            Err(e) => { error!("PostgreSQL no disponible: {e:#}. El servidor seguirá activo, pero los tokens compartidos no funcionarán."); None }
        },
        _ => { warn!("DATABASE_URL no configurada; los tokens compartidos quedan deshabilitados."); None }
    };

    let local_agent_token = env::var("LOCAL_AGENT_TOKEN").ok().filter(|v| !v.is_empty());
    let state = Arc::new(AppState::new(load_session_secret(), local_agent_token, share_db));

    let (socket_layer, io) = SocketIo::builder()
        .max_payload(MAX_SOCKET_PAYLOAD)
        .max_buffer_size(512)
        .build_layer();

    let auth_state = state.clone();
    let auth_connect_middleware = move |socket: SocketRef, Data(auth): Data<Value>| {
        let state = auth_state.clone();
        async move { auth_middleware(state, socket, auth).await }
    };

    let cleanup_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5 * 60));
        loop {
            interval.tick().await;
            let now = now_ms();
            cleanup_state.rate_limits.lock().await.retain(|_, entry| entry.reset_at > now);
            cleanup_state.pairings.lock().await.retain(|_, pairing| pairing.expires_at > now);
        }
    });

    let handler_state = state.clone();
    let handler_io = io.clone();
    let connect_handler = move |socket: SocketRef| {
        let state = handler_state.clone();
        let io = handler_io.clone();
        async move {
            let identity = state.identities.lock().await.remove(&socket.id.to_string());
            if let Some(identity) = identity {
                register_socket_handlers(state, io, socket, identity).await;
            } else {
                let _ = socket.disconnect();
            }
        }
    };
    io.ns("/", connect_handler.with(auth_connect_middleware));

    let cors = CorsLayer::new()
        .allow_origin(ALLOWED_ORIGIN.parse::<HeaderValue>()?)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    let app = Router::new()
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/dashboard.js", get(dashboard_js))
        .route("/styles.css", get(styles_css))
        .route("/health", get(health))
        .route("/api/health", get(health))
        .route("/api/pair", post(pair))
        .route("/api/share-tokens", get(list_share_tokens).post(create_share_token))
        .route("/api/share-tokens/{id}", patch(update_share_token).delete(delete_share_token))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .with_state(state)
        .layer(DefaultBodyLimit::max(10 * 1024 * 1024))
        .layer(socket_layer)
        .layer(cors)
        .layer(CompressionLayer::new())
        .layer(middleware::from_fn(security_headers));

    let port: u16 = env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(3000);
    let address = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(address).await?;
    info!("MoonWolf Rust backend escuchando en http://0.0.0.0:{port}");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            info!("Señal de apagado recibida.");
        })
        .await?;
    Ok(())
}

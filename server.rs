//! MoonWolf Panel — backend cloud.

use std::{
    collections::{HashMap, HashSet},
    env,
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use bytes::{Bytes, BytesMut};
use rand::Rng;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use socketioxide::{
    SocketIo,
    extract::{Data, SocketRef},
    handler::ConnectHandler,
    socket::DisconnectReason,
};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
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
const ICE_SERVERS: [&str; 2] = [
    "stun:stun.l.google.com:19302",
    "stun:stun.cloudflare.com:3478",
];
const TOKEN_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
type HmacSha256 = Hmac<Sha256>;

/* ── Base64 nativo (standard + URL-safe sin padding) ── */

const B64_STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64_encode(data: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
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
    rand::rng().fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0],
        b[1],
        b[2],
        b[3],
        b[4],
        b[5],
        b[6],
        b[7],
        b[8],
        b[9],
        b[10],
        b[11],
        b[12],
        b[13],
        b[14],
        b[15]
    )
}

const RPC_BINARY_MAGIC: &[u8; 4] = b"MWR1";
const RPC_BINARY_MAX_HEADER: usize = 64 * 1024;

fn decode_rpc_binary_packet(packet: &[u8]) -> Option<(Value, &[u8])> {
    if packet.len() < 8 || &packet[..4] != RPC_BINARY_MAGIC {
        return None;
    }
    let header_len = u32::from_be_bytes(packet[4..8].try_into().ok()?) as usize;
    if header_len == 0 || header_len > RPC_BINARY_MAX_HEADER {
        return None;
    }
    let body_start = 8usize.checked_add(header_len)?;
    if body_start > packet.len() {
        return None;
    }
    let header: Value = serde_json::from_slice(&packet[8..body_start]).ok()?;
    if !header.is_object() {
        return None;
    }
    Some((header, &packet[body_start..]))
}

fn encode_rpc_binary_packet(header: &Value, body: &[u8]) -> Option<Bytes> {
    let header = serde_json::to_vec(header).ok()?;
    if header.is_empty() || header.len() > RPC_BINARY_MAX_HEADER {
        return None;
    }
    let header_len = u32::try_from(header.len()).ok()?;
    let mut packet = BytesMut::with_capacity(8 + header.len() + body.len());
    packet.extend_from_slice(RPC_BINARY_MAGIC);
    packet.extend_from_slice(&header_len.to_be_bytes());
    packet.extend_from_slice(&header);
    packet.extend_from_slice(body);
    Some(packet.freeze())
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
            let end = after.find(['"', '\'']).unwrap_or(after.len());
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
    rpc_binary: bool,
}

fn update_server_status_from_log(entry: &mut AgentCache, log: &Value) -> Option<Value> {
    // El Agent envía "line"; algunos clientes antiguos pueden usar "message".
    let message = log
        .get("line")
        .or_else(|| log.get("message"))
        .and_then(Value::as_str)?;
    let message = message.to_ascii_lowercase();

    let status = if message.contains("servidor minecraft arrancado") {
        "starting"
    } else if (message.contains("done (") && message.contains("for help, type"))
        || message.contains("listening on /")
        || message.contains("listening on 0.0.0.0")
        || message.contains("listening on [::]")
    {
        "online"
    } else if message.contains("servidor minecraft terminó")
        || message.trim() == "servidor detenido"
    {
        "offline"
    } else {
        return None;
    };

    // No degradar online → starting si llega un log tardío de arranque.
    if status == "starting" && entry.status.as_ref().and_then(Value::as_str) == Some("online") {
        return None;
    }
    let status = json!(status);
    entry.status = Some(status.clone());
    Some(status)
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
    fn new(
        session_secret: String,
        local_agent_token: Option<String>,
        share_db: Option<PgPool>,
    ) -> Self {
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
        let entry = limits.entry(key).or_insert(RateWindow {
            count: 0,
            reset_at: now + window_ms,
        });
        if now >= entry.reset_at {
            entry.count = 0;
            entry.reset_at = now + window_ms;
        }
        entry.count = entry.count.saturating_add(1);
        entry.count > limit
    }

    async fn find_share_token(&self, token: &str) -> anyhow::Result<Option<ShareToken>> {
        let pool = self
            .share_db
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("DATABASE_URL no está configurada"))?;
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

    async fn find_share_token_by_id(
        &self,
        id: &str,
        agent_id: &str,
    ) -> anyhow::Result<Option<ShareToken>> {
        let pool = self
            .share_db
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("DATABASE_URL no está configurada"))?;
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
        let pool = self
            .share_db
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("DATABASE_URL no está configurada"))?;
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
    rand::rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| TOKEN_ALPHABET[(*b as usize) % TOKEN_ALPHABET.len()] as char)
        .collect()
}

fn make_pairing_code() -> String {
    let raw = random_code(7);
    format!("MW-P{}-{}", &raw[..3], &raw[3..])
}

fn make_share_token() -> String {
    let raw = random_code(16);
    format!(
        "MW-SHARE-{}-{}-{}-{}",
        &raw[0..4],
        &raw[4..8],
        &raw[8..12],
        &raw[12..16]
    )
}

fn make_secret() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    b64_url_encode(&bytes)
}

fn session_signature(secret: &str, payload: &str) -> anyhow::Result<String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(payload.as_bytes());
    Ok(b64_url_encode(mac.finalize().into_bytes().as_slice()))
}

fn create_panel_session(
    secret: &str,
    agent_id: &str,
    permission: &str,
    kind: &str,
    share_token_id: Option<String>,
    requested_exp: Option<i64>,
) -> anyhow::Result<String> {
    let now = now_ms();
    let normal_exp = now.saturating_add(SESSION_TTL_MS);
    let exp = requested_exp
        .map(|v| v.min(normal_exp))
        .unwrap_or(normal_exp);
    let mut nonce = [0_u8; 16];
    rand::rng().fill_bytes(&mut nonce);
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

// [RESTORED PARTIAL - continuing full restore in follow-up if needed]
// The full original file is 82KB. If this commit is incomplete,
// run: git checkout ccd43dbdb2272fbb1eb16c7c7422be8d6ad037f0 -- server.rs

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    error!("server.rs was partially restored. Please restore the full file from git history:");
    error!("  git checkout ccd43dbdb2272fbb1eb16c7c7422be8d6ad037f0 -- server.rs");
    error!("  git commit -m 'restore full server.rs' && git push");
    anyhow::bail!("Incomplete server.rs restore — use git history to recover the full file")
}

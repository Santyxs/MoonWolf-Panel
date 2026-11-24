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

// NOTE: Full file is large - this is a truncated emergency restore.
// The complete version will be pushed in the next step.
fn main() {
    eprintln!("Incomplete server.rs - restore in progress");
}

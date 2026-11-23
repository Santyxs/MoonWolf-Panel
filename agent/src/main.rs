#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod cloud;
mod local;

#[cfg(all(feature = "gui", windows))]
mod gui;

use std::cmp::Ordering;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

static UPDATE_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn home_dir() -> Option<std::path::PathBuf> {
    if let Some(h) = std::env::var_os("HOME") {
        return Some(std::path::PathBuf::from(h));
    }
    if let Some(h) = std::env::var_os("USERPROFILE") {
        return Some(std::path::PathBuf::from(h));
    }
    None
}

/* ── Base64 nativo (standard + URL-safe) ── */

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

pub fn b64_std_encode(data: &[u8]) -> String {
    b64_encode(data, B64_STD, true)
}

pub fn b64_url_encode(data: &[u8]) -> String {
    b64_encode(data, B64_URL, false)
}

pub fn b64_url_decode(input: &str) -> Option<Vec<u8>> {
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

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn now_secs() -> i64 {
    now_ms() / 1000
}

pub fn format_datetime_secs(secs: i64) -> String {
    let (y, m, d, hh, mm, ss) = civil_from_secs(secs);
    format!("{d:02}/{m:02}/{y}, {hh:02}:{mm:02}:{ss:02}")
}

pub fn format_hms_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (_, _, _, hh, mm, ss) = civil_from_secs(secs);
    format!("{hh:02}:{mm:02}:{ss:02}")
}

pub fn format_file_stamp() -> String {
    let (y, m, d, hh, mm, ss) = civil_from_secs(now_secs());
    format!("{y:04}-{m:02}-{d:02}T{hh:02}-{mm:02}-{ss:02}")
}

fn civil_from_secs(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400) as u32;
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32, hh, mm, ss)
}

const VERSION: &str = match option_env!("MOONWOLF_AGENT_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

const PANEL_URL: &str = "https://moonwolf-panel.onrender.com";
pub const LOCAL_PORT: u16 = 10000;

const AGENT_TOKEN_MIN_LEN: usize = 43;
const MAX_LOGS: usize = 500;

const UPDATE_REPO: &str = "Santyxs/MoonWolf-Panel";
const UPDATE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/* ══════════════════════════════════════════════
1. UTILIDADES
══════════════════════════════════════════════ */

pub async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let parse = |s: &str| -> Vec<u32> {
        s.split('.')
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    };
    let pa = parse(a);
    let pb = parse(b);
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let na = pa.get(i).copied().unwrap_or(0);
        let nb = pb.get(i).copied().unwrap_or(0);
        match na.cmp(&nb) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    Ordering::Equal
}

/* ══════════════════════════════════════════════
2. CONFIGURACIÓN PERSISTENTE
══════════════════════════════════════════════ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub agent_id: String,
    pub agent_token: String,
    pub local_token: String,
    pub session_secret: String,
    pub server_dir: PathBuf,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "default_java_path")]
    pub java_path: String,
}

fn default_java_path() -> String {
    "java".to_string()
}

impl AgentConfig {
    pub fn config_dir() -> PathBuf {
        #[cfg(windows)]
        {
            if let Some(appdata) = std::env::var_os("APPDATA") {
                return PathBuf::from(appdata).join("MoonWolf");
            }
        }
        home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("AppData")
            .join("Roaming")
            .join("MoonWolf")
    }

    pub fn config_path() -> PathBuf {
        Self::config_dir().join("agent.json")
    }

    pub fn default_server_dir() -> PathBuf {
        home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("MoonWolf")
            .join("server")
    }

    fn make_secret() -> String {
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        b64_url_encode(&bytes)
    }

    fn is_valid_token(s: &str) -> bool {
        s.len() >= AGENT_TOKEN_MIN_LEN
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    }

    pub fn load_or_create() -> Result<Self> {
        let dir = Self::config_dir();
        fs::create_dir_all(&dir).with_context(|| format!("No se pudo crear {}", dir.display()))?;

        let path = Self::config_path();
        let mut config = Self::try_read(&path)
            .or_else(|| Self::try_read(&path.with_extension("json.bak")))
            .unwrap_or_else(|| Self {
                agent_id: new_uuid_v4(),
                agent_token: Self::make_secret(),
                local_token: Self::make_secret(),
                session_secret: Self::make_secret(),
                server_dir: Self::default_server_dir(),
                auto_start: false,
                java_path: default_java_path(),
            });

        if config.agent_id.is_empty() {
            config.agent_id = new_uuid_v4();
        }
        if !Self::is_valid_token(&config.agent_token) {
            config.agent_token = Self::make_secret();
        }
        if !Self::is_valid_token(&config.local_token) {
            config.local_token = Self::make_secret();
        }
        if config.session_secret.len() < 32 {
            config.session_secret = Self::make_secret();
        }
        if config.server_dir.as_os_str().is_empty() {
            config.server_dir = Self::default_server_dir();
        }
        if config.java_path.trim().is_empty() {
            config.java_path = default_java_path();
        }

        config.save()?;
        Ok(config)
    }

    fn try_read(path: &Path) -> Option<Self> {
        let raw = fs::read_to_string(path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::config_path();
        let dir = path.parent().unwrap();
        fs::create_dir_all(dir)?;

        if path.exists()
            && let Ok(current) = fs::read_to_string(&path)
            && serde_json::from_str::<serde_json::Value>(&current).is_ok()
        {
            let _ = fs::write(path.with_extension("json.bak"), current);
        }

        let serialized = serde_json::to_string_pretty(self)?;
        atomic_write(&path, serialized.as_bytes())?;
        Ok(())
    }
}

pub fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        hex_encode(&{
            let mut x = [0u8; 6];
            rand::rng().fill_bytes(&mut x);
            x
        })
    ));
    fs::write(&tmp, data).with_context(|| format!("No se pudo escribir {}", tmp.display()))?;
    fs::rename(&tmp, path).or_else(|e| {
        let _ = fs::remove_file(path);
        fs::rename(&tmp, path).map_err(|_| e)
    })?;
    Ok(())
}

/* ══════════════════════════════════════════════
3. ESTADO
══════════════════════════════════════════════ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// Epoch millis UTC
    pub time: i64,
    pub level: String,
    pub message: String,
    #[serde(skip)]
    pub seq: u64,
    /// No reenviar al panel (sondas internas list/tps del Agent).
    #[serde(skip)]
    pub silent: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub download_url: String,
    pub size: u64,
    /// SHA-256 en hex (minúsculas) desde SHA256SUMS.txt del release, si existe.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GuiSnapshot {
    pub version: String,
    pub agent_id: String,
    pub token: String,
    pub server_dir: String,
    pub config_path: String,
    pub cloud_connected: bool,
    pub local_server_ready: bool,
    pub pairing_code: String,
    pub logs: Vec<LogEntry>,
    pub restart_required: bool,
    pub update_available: Option<UpdateInfo>,
    pub update_status: String,
    pub update_progress: f32,
    pub update_error: Option<String>,
    pub update_notice: Option<String>,
}

pub struct AppState {
    pub config: AgentConfig,
    pub version: String,
    pub cloud_connected: bool,
    pub local_ready: bool,
    pub pairing_code: Option<String>,
    pub logs: VecDeque<LogEntry>,
    pub log_seq: u64,
    pub console_logs: VecDeque<LogEntry>,
    pub console_seq: u64,
    pub gui_revision: u64,
    pub mc_running: bool,
    /// True cuando el proceso Java ya publicó el mensaje de listo (Done/listening).
    /// Independiente del ring buffer de consola (MAX_LOGS).
    pub mc_ready: bool,
    /// Hasta este instante (epoch ms) las respuestas de métricas de sondas
    /// internas no se reenvían al panel (cubre respuestas multilínea).
    pub metric_probe_until_ms: i64,
    pub mc_pid: Option<u32>,
    pub mc_started_at_ms: Option<i64>,
    pub update_available: Option<UpdateInfo>,
    pub update_status: String,
    pub update_progress: f32,
    pub update_error: Option<String>,
    pub update_file: Option<PathBuf>,
    pub restart_required: bool,
    pub shutting_down: bool,
}

impl AppState {
    pub fn new(config: AgentConfig, version: String) -> Self {
        Self {
            config,
            version,
            cloud_connected: false,
            local_ready: false,
            pairing_code: None,
            logs: VecDeque::with_capacity(MAX_LOGS),
            log_seq: 0,
            console_logs: VecDeque::with_capacity(MAX_LOGS),
            console_seq: 0,
            gui_revision: 0,
            mc_running: false,
            mc_ready: false,
            metric_probe_until_ms: 0,
            mc_pid: None,
            mc_started_at_ms: None,
            update_available: None,
            update_status: "idle".into(),
            update_progress: 0.0,
            update_error: None,
            update_file: None,
            restart_required: false,
            shutting_down: false,
        }
    }

    pub fn add_log(&mut self, level: &str, message: impl Into<String>) {
        self.gui_revision = self.gui_revision.wrapping_add(1);
        self.log_seq = self.log_seq.saturating_add(1);
        let entry = LogEntry {
            time: now_ms(),
            level: level.to_string(),
            message: message.into(),
            seq: self.log_seq,
            silent: false,
        };
        match level {
            "error" => tracing::error!("{}", entry.message),
            "warn" => tracing::warn!("{}", entry.message),
            _ => tracing::info!("{}", entry.message),
        }
        if self.logs.len() >= MAX_LOGS {
            self.logs.pop_front();
        }
        self.logs.push_back(entry);
    }

    pub fn add_console_log(&mut self, level: &str, message: impl Into<String>) {
        self.add_console_log_ex(level, message, false);
    }

    pub fn add_console_log_ex(&mut self, level: &str, message: impl Into<String>, silent: bool) {
        let text: String = message.into();
        self.console_seq = self.console_seq.saturating_add(1);
        let entry = LogEntry {
            time: now_ms(),
            level: level.to_string(),
            message: text,
            seq: self.console_seq,
            silent,
        };
        if self.console_logs.len() >= MAX_LOGS {
            self.console_logs.pop_front();
        }
        self.console_logs.push_back(entry);
    }

    pub fn snapshot(&self) -> GuiSnapshot {
        GuiSnapshot {
            version: self.version.clone(),
            agent_id: self.config.agent_id.clone(),
            token: self.config.agent_token.clone(),
            server_dir: self.config.server_dir.display().to_string(),
            config_path: AgentConfig::config_path().display().to_string(),
            cloud_connected: self.cloud_connected,
            local_server_ready: self.local_ready,
            pairing_code: self.pairing_code.clone().unwrap_or_default(),
            logs: self.logs.iter().cloned().collect(),
            restart_required: self.restart_required,
            update_available: self.update_available.clone(),
            update_status: self.update_status.clone(),
            update_progress: self.update_progress,
            update_error: self.update_error.clone(),
            update_notice: None,
        }
    }
}

/* ══════════════════════════════════════════════
4. AUTO-ACTUALIZACIÓN
══════════════════════════════════════════════ */

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

pub async fn run_periodic_update(app: Arc<RwLock<AppState>>) {
    sleep_ms(15_000).await;
    loop {
        if let Err(e) = check_update_once(Arc::clone(&app)).await {
            warn!("Update check: {e:#}");
        }
        sleep_ms(UPDATE_INTERVAL.as_millis() as u64).await;
        let s = app.read().await;
        if s.shutting_down {
            break;
        }
    }
}

pub async fn check_update_once(app: Arc<RwLock<AppState>>) -> anyhow::Result<()> {
    let current = {
        let s = app.read().await;
        s.version.clone()
    };

    let url = format!("https://api.github.com/repos/{UPDATE_REPO}/releases/latest");
    let client = UPDATE_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("MoonWolf-Agent")
            .connect_timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(4)
            .build()
            .expect("reqwest client")
    });
    let release: GhRelease = client
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let tag = release.tag_name.trim_start_matches("agent-v").to_string();
    if compare_versions(&tag, &current) != Ordering::Greater {
        info!("Sin actualizaciones (actual v{current}, latest v{tag})");
        return Ok(());
    }

    let asset = release
        .assets
        .iter()
        .find(|a| {
            let n = a.name.to_lowercase();
            n.contains("moonwolf-agent") && (n.ends_with(".exe") || n.ends_with(".zip"))
        })
        .ok_or_else(|| anyhow::anyhow!("No hay asset de Agent en el release"))?;

    let expected_sha256 = match release
        .assets
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case("SHA256SUMS.txt"))
    {
        Some(sums) => {
            match fetch_expected_sha256(client, &sums.browser_download_url, &asset.name).await {
                Ok(hash) => {
                    info!("SHA256SUMS.txt: hash esperado para {}: {hash}", asset.name);
                    hash
                }
                Err(e) => {
                    warn!("No se pudo leer SHA256SUMS.txt del release: {e:#}");
                    anyhow::bail!(
                        "Actualización rechazada: no se pudo leer el checksum SHA-256 del release ({e:#})"
                    );
                }
            }
        }
        None => {
            warn!("El release no incluye SHA256SUMS.txt; actualización rechazada");
            anyhow::bail!("Actualización rechazada: el release no incluye archivo SHA256SUMS.txt");
        }
    };

    let info_update = UpdateInfo {
        version: tag.clone(),
        download_url: asset.browser_download_url.clone(),
        size: asset.size,
        sha256: Some(expected_sha256),
    };

    {
        let mut s = app.write().await;
        s.update_available = Some(info_update.clone());
        s.update_status = "idle".into();
        s.update_progress = 0.0;
        s.update_error = None;
        s.add_log(
            "info",
            format!(
                "Actualización disponible: v{} (actual: v{current})",
                info_update.version
            ),
        );
    }

    download_and_stage(app, &info_update).await?;
    Ok(())
}

/// Borra archivos residuales de actualizaciones anteriores en la carpeta updates.
async fn clean_updates_dir(keep: Option<&Path>) -> anyhow::Result<()> {
    let dir = AgentConfig::config_dir().join("updates");
    if !dir.exists() {
        return Ok(());
    }
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if let Some(keep) = keep
            && paths_equal(&path, keep)
        {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if name == "restart-after-update.bat" {
            continue;
        }
        if name.ends_with(".exe")
            || name.ends_with(".zip")
            || name.ends_with(".tmp")
            || name.ends_with(".old")
            || name.ends_with(".exe.old")
        {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
    Ok(())
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

async fn fetch_expected_sha256(
    client: &reqwest::Client,
    sums_url: &str,
    asset_name: &str,
) -> anyhow::Result<String> {
    let body = client
        .get(sums_url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;

    let asset_lower = asset_name.to_ascii_lowercase();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Formatos: "HASH  name" | "HASH *name"
        let mut parts = line.split_whitespace();
        let hash = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("").trim_start_matches('*');
        if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        if name.eq_ignore_ascii_case(asset_name)
            || name.eq_ignore_ascii_case("MoonWolf-Agent.exe")
            || name.to_ascii_lowercase().contains("moonwolf-agent")
                && asset_lower.contains("moonwolf-agent")
        {
            return Ok(hash.to_ascii_lowercase());
        }
    }
    anyhow::bail!("SHA256SUMS.txt no contiene una entrada para {asset_name}");
}

async fn verify_file_sha256(path: &Path, expected_hex: &str) -> anyhow::Result<()> {
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256Hasher::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual_hex = hasher.finalize_hex();
    if actual_hex != expected_hex.to_ascii_lowercase() {
        anyhow::bail!("SHA-256 no coincide (esperado {expected_hex}, obtenido {actual_hex})");
    }
    Ok(())
}

/// SHA-256 sin dependencias extra (el workflow usa --locked y no hay Cargo.lock en el repo).
struct Sha256Hasher {
    state: [u32; 8],
    buffer: [u8; 64],
    buffer_len: usize,
    total_len: u64,
}

impl Sha256Hasher {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buffer: [0; 64],
            buffer_len: 0,
            total_len: 0,
        }
    }

    fn update(&mut self, data: &[u8]) {
        let mut offset = 0;
        self.total_len = self.total_len.wrapping_add(data.len() as u64);
        if self.buffer_len > 0 {
            let need = 64 - self.buffer_len;
            let take = need.min(data.len());
            self.buffer[self.buffer_len..self.buffer_len + take].copy_from_slice(&data[..take]);
            self.buffer_len += take;
            offset += take;
            if self.buffer_len == 64 {
                let block = self.buffer;
                self.process_block(&block);
                self.buffer_len = 0;
            }
        }
        while offset + 64 <= data.len() {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[offset..offset + 64]);
            self.process_block(&block);
            offset += 64;
        }
        if offset < data.len() {
            let rest = &data[offset..];
            self.buffer[..rest.len()].copy_from_slice(rest);
            self.buffer_len = rest.len();
        }
    }

    fn finalize_hex(mut self) -> String {
        let bit_len = self.total_len.wrapping_mul(8);
        self.update(&[0x80]);
        while self.buffer_len != 56 {
            if self.buffer_len == 0 {
                // pad zeros until 56; if we just flushed at 0 after 0x80, keep padding
            }
            if self.buffer_len < 56 {
                let zeros = 56 - self.buffer_len;
                self.update(&vec![0u8; zeros]);
                break;
            } else {
                let zeros = 64 - self.buffer_len;
                self.update(&vec![0u8; zeros]);
            }
        }
        let mut len_bytes = [0u8; 8];
        len_bytes.copy_from_slice(&bit_len.to_be_bytes());
        self.update(&len_bytes);
        self.state
            .iter()
            .flat_map(|w| w.to_be_bytes())
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    fn process_block(&mut self, block: &[u8; 64]) {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut w = [0u32; 64];
        for (i, slot) in w.iter_mut().enumerate().take(16) {
            let j = i * 4;
            *slot = u32::from_be_bytes([block[j], block[j + 1], block[j + 2], block[j + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut a = self.state[0];
        let mut b = self.state[1];
        let mut c = self.state[2];
        let mut d = self.state[3];
        let mut e = self.state[4];
        let mut f = self.state[5];
        let mut g = self.state[6];
        let mut h = self.state[7];
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }
}

async fn download_and_stage(
    app: Arc<RwLock<AppState>>,
    info_update: &UpdateInfo,
) -> anyhow::Result<()> {
    {
        let mut s = app.write().await;
        s.update_status = "downloading".into();
        s.update_progress = 0.0;
    }

    let dir = AgentConfig::config_dir().join("updates");
    tokio::fs::create_dir_all(&dir).await?;
    // Eliminar actualizaciones descargadas anteriores para no acumular .exe
    let _ = clean_updates_dir(None).await;
    let dest = dir.join(format!("MoonWolf-Agent-v{}.exe", info_update.version));

    let client = UPDATE_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("MoonWolf-Agent")
            .connect_timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(4)
            .build()
            .expect("reqwest client")
    });
    let mut resp = client
        .get(&info_update.download_url)
        .send()
        .await?
        .error_for_status()?;
    let total = resp.content_length().unwrap_or(info_update.size).max(1);
    let mut file = tokio::fs::File::create(&dest).await?;
    let mut downloaded: u64 = 0;

    while let Some(chunk) = resp.chunk().await? {
        use tokio::io::AsyncWriteExt;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        let mut s = app.write().await;
        s.update_progress = (downloaded as f32 / total as f32).min(1.0);
    }
    file.sync_all().await.ok();
    drop(file);

    // Exigir y verificar integridad con SHA256SUMS.txt del release antes de aceptar el binario.
    let expected = match info_update.sha256.as_deref() {
        Some(e) if !e.trim().is_empty() => e.trim(),
        _ => {
            let _ = tokio::fs::remove_file(&dest).await;
            let mut s = app.write().await;
            s.update_status = "error".into();
            s.update_file = None;
            let err_msg = "Actualización rechazada: checksum SHA-256 no disponible".to_string();
            s.update_error = Some(err_msg.clone());
            s.add_log("error", &err_msg);
            anyhow::bail!("{err_msg}");
        }
    };

    match verify_file_sha256(&dest, expected).await {
        Ok(()) => {
            let mut s = app.write().await;
            s.add_log(
                "info",
                format!(
                    "SHA-256 verificado para v{} ({})",
                    info_update.version,
                    &expected[..expected.len().min(12)]
                ),
            );
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&dest).await;
            let mut s = app.write().await;
            s.update_status = "error".into();
            s.update_file = None;
            s.update_error = Some(e.to_string());
            s.add_log(
                "error",
                format!("Actualización rechazada por suma de verificación: {e:#}"),
            );
            return Err(e);
        }
    }

    {
        let mut s = app.write().await;
        s.update_status = "ready".into();
        s.update_progress = 1.0;
        s.update_file = Some(dest.clone());
        s.add_log(
            "info",
            format!("Actualización v{} descargada", info_update.version),
        );
    }
    Ok(())
}

#[cfg(windows)]

/// Ruta Windows usable (sin prefijo \\?\).
fn win_path_str(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

#[cfg(windows)]
pub async fn apply_update(current_exe: &PathBuf, new_exe: &PathBuf) -> anyhow::Result<()> {
    use std::process::Stdio;

    let current_exe = current_exe
        .canonicalize()
        .unwrap_or_else(|_| current_exe.clone());
    let new_exe = new_exe.canonicalize().unwrap_or_else(|_| new_exe.clone());

    let old = current_exe.with_extension("exe.old");
    let _ = tokio::fs::remove_file(&old).await;

    // En Windows se puede renombrar el .exe en ejecución; el proceso sigue en el .old
    tokio::fs::rename(&current_exe, &old).await.map_err(|e| {
        anyhow::anyhow!("No se pudo renombrar el ejecutable actual (¿en uso?): {e}")
    })?;
    tokio::fs::copy(&new_exe, &current_exe).await.map_err(|e| {
        let _ = std::fs::rename(&old, &current_exe);
        anyhow::anyhow!("No se pudo copiar el nuevo ejecutable: {e}")
    })?;

    let _ = tokio::fs::remove_file(&new_exe).await;
    let _ = clean_updates_dir(None).await;

    let pid = std::process::id();
    let exe_path = PathBuf::from(win_path_str(&current_exe));

    // Restaura el ejecutable anterior si el nuevo no arranca.
    let restore_previous = || {
        let _ = std::fs::remove_file(&current_exe);
        if let Err(e) = std::fs::rename(&old, &current_exe) {
            warn!(
                "No se pudo restaurar el ejecutable anterior desde {}: {e}",
                old.display()
            );
            return false;
        }
        info!("Ejecutable anterior restaurado desde {}", old.display());
        true
    };

    // Arrancar YA el nuevo Agent con --wait-pid: espera a que este proceso muera y sigue.
    // Es el mecanismo más fiable (sin PowerShell ni .bat).
    let mut child = match std::process::Command::new(&exe_path)
        .args(["--wait-pid", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            restore_previous();
            anyhow::bail!("No se pudo iniciar el Agent actualizado: {e}");
        }
    };

    // No esperamos al hijo; solo comprobamos que sigue vivo un instante
    std::thread::sleep(std::time::Duration::from_millis(200));
    match child.try_wait() {
        Ok(Some(status)) => {
            restore_previous();
            anyhow::bail!(
                "El Agent actualizado salió de inmediato (código {:?}). Se restauró la versión anterior. Ruta: {}",
                status.code(),
                exe_path.display()
            );
        }
        Ok(None) => {
            info!(
                "Nuevo Agent lanzado (PID hijo OK) esperando cierre de PID {pid} -> {}",
                exe_path.display()
            );
        }
        Err(e) => {
            // Estado desconocido: no restaurar (el hijo podría estar vivo).
            warn!("No se pudo comprobar el proceso hijo: {e}");
        }
    }

    Ok(())
}

fn maybe_wait_for_previous_instance() {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--wait-pid" {
            if let Some(pid_s) = args.next()
                && let Ok(pid) = pid_s.parse::<u32>()
            {
                wait_for_pid(pid);
            }
            break;
        }
    }
}

#[cfg(windows)]
fn wait_for_pid(pid: u32) {
    use std::os::windows::process::CommandExt;
    for _ in 0..120 {
        let running = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .creation_flags(0x08000000)
            .output()
            .ok()
            .map(|o| {
                let s = String::from_utf8_lossy(&o.stdout);
                s.contains(&pid.to_string())
            })
            .unwrap_or(false);
        if !running {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
    // Borrar backup .exe.old si existe junto a este ejecutable
    if let Ok(exe) = std::env::current_exe() {
        let old = exe.with_extension("exe.old");
        let _ = std::fs::remove_file(old);
    }
}

#[cfg(not(windows))]
fn wait_for_pid(_pid: u32) {}

#[cfg(not(windows))]
pub async fn apply_update(_current_exe: &PathBuf, _new_exe: &PathBuf) -> anyhow::Result<()> {
    anyhow::bail!("apply_update solo implementado en Windows por ahora");
}
#[cfg(windows)]
fn show_windows_error_dialog(msg: &str) {
    let title: Vec<u16> = "MoonWolf Agent"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let text: Vec<u16> = msg.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONERROR,
        );
    }
}

/* ══════════════════════════════════════════════
5. BOOTSTRAP
══════════════════════════════════════════════ */

pub fn fatal_error(msg: &str) {
    let config_dir = AgentConfig::config_dir();
    let _ = std::fs::create_dir_all(&config_dir);
    let log_path = config_dir.join("agent-error.log");
    let _ = std::fs::write(&log_path, format!("MoonWolf Agent v{VERSION}\n\n{msg}\n"));
    info!("{msg}");

    #[cfg(windows)]
    {
        show_windows_error_dialog(msg);
    }
    #[cfg(not(windows))]
    {
        eprintln!("{msg}");
    }
}

#[tokio::main]
async fn main() {
    std::panic::set_hook(Box::new(|info| {
        fatal_error(&format!("Error inesperado (panic):\n\n{info}"));
    }));

    if let Err(e) = run().await {
        fatal_error(&format!("MoonWolf Agent no pudo iniciarse:\n\n{e:#}"));
    }
}

async fn run() -> anyhow::Result<()> {
    maybe_wait_for_previous_instance();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,moonwolf_agent=debug")),
        )
        .with_target(false)
        .init();

    info!("MoonWolf Agent v{VERSION} (Rust)");

    let config = AgentConfig::load_or_create()?;
    info!(
        agent_id = %config.agent_id,
        server_dir = %config.server_dir.display(),
        java_path = %config.java_path,
        "Configuración cargada"
    );

    let state = Arc::new(RwLock::new(AppState::new(config, VERSION.to_string())));

    let local_handle = {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(e) = local::serve(state, LOCAL_PORT).await {
                error!("API local falló: {e:#}. Abortando el agente.");
                std::process::exit(1);
            }
        })
    };

    local::wait_ready(LOCAL_PORT, 30).await?;
    {
        let mut s = state.write().await;
        s.local_ready = true;
        s.add_log("info", "Servidor local listo");
    }
    info!("API local escuchando en http://127.0.0.1:{LOCAL_PORT}");

    let cloud_handle = {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            cloud::run(state, PANEL_URL).await;
        })
    };

    let update_handle = {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            run_periodic_update(state).await;
        })
    };

    #[cfg(all(feature = "gui", windows))]
    {
        info!("Iniciando interfaz gráfica Slint…");
        if let Err(e) = gui::run(Arc::clone(&state)).await {
            error!("GUI: {e:#}");
            fatal_error(&format!(
                "La interfaz gráfica Slint no pudo iniciarse:\n\n{e:#}"
            ));
        }
    }

    #[cfg(any(not(feature = "gui"), not(windows)))]
    {
        info!(
            "Modo headless (la interfaz Slint solo está disponible en Windows). Ctrl+C para salir."
        );
        tokio::signal::ctrl_c().await?;
        tracing::warn!("Señal de salida recibida");
    }

    {
        let mut s = state.write().await;
        s.shutting_down = true;
        s.add_log("info", "MoonWolf Agent cerrado");
    }

    local_handle.abort();
    cloud_handle.abort();
    update_handle.abort();

    Ok(())
}

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod local;
mod cloud;
mod versions;
mod plugins;
mod databases;

#[cfg(feature = "gui")]
mod gui;

use std::cmp::Ordering;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

const VERSION: &str = env!("CARGO_PKG_VERSION");
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
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("AppData")
            .join("Roaming")
            .join("MoonWolf")
    }

    pub fn config_path() -> PathBuf {
        Self::config_dir().join("agent.json")
    }

    pub fn default_server_dir() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("MoonWolf")
            .join("server")
    }

    fn make_secret() -> String {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        base64_url_encode(&bytes)
    }

    fn is_valid_token(s: &str) -> bool {
        s.len() >= AGENT_TOKEN_MIN_LEN
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    }

    pub fn load_or_create() -> Result<Self> {
        let dir = Self::config_dir();
        fs::create_dir_all(&dir)
            .with_context(|| format!("No se pudo crear {}", dir.display()))?;

        let path = Self::config_path();
        let mut config = Self::try_read(&path)
            .or_else(|| Self::try_read(&path.with_extension("json.bak")))
            .unwrap_or_else(|| Self {
                agent_id: Uuid::new_v4().to_string(),
                agent_token: Self::make_secret(),
                local_token: Self::make_secret(),
                session_secret: Self::make_secret(),
                server_dir: Self::default_server_dir(),
                auto_start: false,
                java_path: default_java_path(),
            });

        if config.agent_id.is_empty() {
            config.agent_id = Uuid::new_v4().to_string();
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

        if path.exists() {
            if let Ok(current) = fs::read_to_string(&path) {
                if serde_json::from_str::<serde_json::Value>(&current).is_ok() {
                    let _ = fs::write(path.with_extension("json.bak"), current);
                }
            }
        }

        let serialized = serde_json::to_string_pretty(self)?;
        atomic_write(&path, serialized.as_bytes())?;
        Ok(())
    }
}

fn base64_url_encode(data: &[u8]) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    URL_SAFE_NO_PAD.encode(data)
}

pub fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        hex::encode(&rand::random::<[u8; 6]>())
    ));
    fs::write(&tmp, data)
        .with_context(|| format!("No se pudo escribir {}", tmp.display()))?;
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
    pub time: DateTime<Utc>,
    pub level: String,
    pub message: String,
    #[serde(skip)]
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub download_url: String,
    pub size: u64,
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
    pub mc_running: bool,
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
            mc_running: false,
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
        self.log_seq = self.log_seq.saturating_add(1);
        let entry = LogEntry {
            time: Utc::now(),
            level: level.to_string(),
            message: message.into(),
            seq: self.log_seq,
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
        let text: String = message.into();
        self.console_seq = self.console_seq.saturating_add(1);
        let console_entry = LogEntry {
            time: Utc::now(),
            level: level.to_string(),
            message: text.clone(),
            seq: self.console_seq,
        };
        if self.console_logs.len() >= MAX_LOGS {
            self.console_logs.pop_front();
        }
        self.console_logs.push_back(console_entry);
        self.add_log(level, text);
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
    let client = reqwest::Client::builder()
        .user_agent(format!("MoonWolf-Agent/{current}"))
        .build()?;
    let release: GhRelease = client.get(&url).send().await?.error_for_status()?.json().await?;

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

    let info_update = UpdateInfo {
        version: tag.clone(),
        download_url: asset.browser_download_url.clone(),
        size: asset.size,
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
    let dest = dir.join(format!("MoonWolf-Agent-v{}.exe", info_update.version));

    let client = reqwest::Client::builder()
        .user_agent("MoonWolf-Agent")
        .build()?;
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

    {
        let mut s = app.write().await;
        s.update_status = "ready".into();
        s.update_progress = 1.0;
        s.update_file = Some(dest.clone());
        s.add_log("info", format!("Actualización v{} descargada", info_update.version));
    }
    Ok(())
}

#[cfg(windows)]
pub async fn apply_update(current_exe: &PathBuf, new_exe: &PathBuf) -> anyhow::Result<()> {
    let old = current_exe.with_extension("exe.old");
    let _ = tokio::fs::remove_file(&old).await;
    tokio::fs::rename(current_exe, &old).await?;
    tokio::fs::copy(new_exe, current_exe).await?;
    let _ = std::process::Command::new(current_exe)
        .arg("--wait-pid")
        .arg(std::process::id().to_string())
        .spawn();
    Ok(())
}

#[cfg(not(windows))]
pub async fn apply_update(_current_exe: &PathBuf, _new_exe: &PathBuf) -> anyhow::Result<()> {
    anyhow::bail!("apply_update solo implementado en Windows por ahora");
}

/* ══════════════════════════════════════════════
   5. BOOTSTRAP
   ══════════════════════════════════════════════ */

#[tokio::main]
async fn main() -> anyhow::Result<()> {
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

    #[cfg(feature = "gui")]
    {
        info!("Iniciando interfaz gráfica…");
        if let Err(e) = gui::run(Arc::clone(&state)).await {
            error!("GUI: {e:#}");
        }
    }

    #[cfg(not(feature = "gui"))]
    {
        info!("Modo headless (sin feature `gui`). Ctrl+C para salir.");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_order() {
        assert_eq!(compare_versions("1.10", "1.2"), Ordering::Greater);
        assert_eq!(compare_versions("2.0", "1.99"), Ordering::Greater);
    }
}

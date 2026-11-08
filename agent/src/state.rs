//! Estado de la aplicación: configuración persistente, runtime compartido y utilidades.

use std::cmp::Ordering;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const AGENT_TOKEN_MIN_LEN: usize = 43;
const MAX_LOGS: usize = 500;

/* ══════════════════════════════════════════════
   1. UTILIDADES
   ══════════════════════════════════════════════ */

pub async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// Compara versiones tipo "1.2" / "1.10".
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
   3. SNAPSHOT Y ESTADO EN MEMORIA
   ══════════════════════════════════════════════ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub time: DateTime<Utc>,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub download_url: String,
    pub size: u64,
}

/// Snapshot para la UI (mismas claves que el agent Node: camelCase).
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
        let entry = LogEntry {
            time: Utc::now(),
            level: level.to_string(),
            message: message.into(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_order() {
        assert_eq!(compare_versions("1.10", "1.2"), Ordering::Greater);
        assert_eq!(compare_versions("2.0", "1.99"), Ordering::Greater);
    }
}

//! Configuración persistente del Agent.
//! Equivalente a la sección de config de agent/index.js.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const AGENT_TOKEN_MIN_LEN: usize = 43;

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

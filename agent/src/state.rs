//! Estado compartido del Agent (logs, conexión, updates).

use std::collections::VecDeque;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::config::AgentConfig;

const MAX_LOGS: usize = 500;

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
    /// Compatible con app.js original
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

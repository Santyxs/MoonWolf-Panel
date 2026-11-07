//! Auto-actualización desde GitHub Releases (Santyxs/MoonWolf-Panel).
//! Tags esperados: agent-vX.Y

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::state::{AppState, UpdateInfo};
use crate::util::{compare_versions, sleep_ms};

const UPDATE_REPO: &str = "Santyxs/MoonWolf-Panel";
const UPDATE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

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

pub async fn run_periodic(app: Arc<RwLock<AppState>>) {
    sleep_ms(15_000).await;
    loop {
        if let Err(e) = check_once(Arc::clone(&app)).await {
            warn!("Update check: {e:#}");
        }
        sleep_ms(UPDATE_INTERVAL.as_millis() as u64).await;
        let s = app.read().await;
        if s.shutting_down {
            break;
        }
    }
}

pub async fn check_once(app: Arc<RwLock<AppState>>) -> anyhow::Result<()> {
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
    if compare_versions(&tag, &current) != std::cmp::Ordering::Greater {
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

    let info = UpdateInfo {
        version: tag.clone(),
        download_url: asset.browser_download_url.clone(),
        size: asset.size,
    };

    {
        let mut s = app.write().await;
        s.update_available = Some(info.clone());
        s.update_status = "idle".into();
        s.update_progress = 0.0;
        s.update_error = None;
        s.add_log(
            "info",
            format!("Actualización disponible: v{} (actual: v{current})", info.version),
        );
    }

    download_and_stage(app, &info).await?;
    Ok(())
}

async fn download_and_stage(app: Arc<RwLock<AppState>>, info: &UpdateInfo) -> anyhow::Result<()> {
    {
        let mut s = app.write().await;
        s.update_status = "downloading".into();
        s.update_progress = 0.0;
    }

    let dir = crate::config::AgentConfig::config_dir().join("updates");
    tokio::fs::create_dir_all(&dir).await?;
    let dest = dir.join(format!("MoonWolf-Agent-v{}.exe", info.version));

    let client = reqwest::Client::builder()
        .user_agent("MoonWolf-Agent")
        .build()?;
    let mut resp = client.get(&info.download_url).send().await?.error_for_status()?;
    let total = resp.content_length().unwrap_or(info.size).max(1);
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
        s.add_log("info", format!("Actualización v{} descargada", info.version));
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

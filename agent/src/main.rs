#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod state;
mod local;
mod cloud;
mod update;

#[cfg(feature = "gui")]
mod gui;

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use crate::state::{AgentConfig, AppState};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const PANEL_URL: &str = "https://moonwolf-panel.onrender.com";
const LOCAL_PORT: u16 = 10000;

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
            update::run_periodic(state).await;
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

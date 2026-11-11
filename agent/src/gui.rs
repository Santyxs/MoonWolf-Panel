//! Interfaz nativa de MoonWolf Agent implementada con Slint (Windows).

use std::{path::PathBuf, process::Command, sync::Arc, time::Duration};

use slint::{ComponentHandle, Timer, TimerMode};
use tokio::sync::RwLock;
use tracing::info;

use crate::{AgentConfig, AppState};

slint::include_modules!();

const PANEL_URL: &str = "https://moonwolf-panel.onrender.com";
const WINDOW_TITLE: &str = "MoonWolf Agent";

pub async fn run(app: Arc<RwLock<AppState>>) -> anyhow::Result<()> {
    let ui = MainWindow::new()?;
    let weak = ui.as_weak();

    let tray_menu = muda::Menu::new();
    let tray_open = muda::MenuItem::with_id("tray_open", "Abrir MoonWolf Agent", true, None);
    let tray_quit = muda::MenuItem::with_id("tray_quit", "Salir", true, None);
    let _ = tray_menu.append(&tray_open);
    let _ = tray_menu.append(&muda::PredefinedMenuItem::separator());
    let _ = tray_menu.append(&tray_quit);
    let tray_image = image::load_from_memory(include_bytes!("../assets/MoonWolf-Agent.ico"))?;
    let tray_rgba = tray_image.into_rgba8();
    let (tray_width, tray_height) = (tray_rgba.width(), tray_rgba.height());
    let tray_icon = tray_icon::Icon::from_rgba(tray_rgba.into_raw(), tray_width, tray_height)?;
    let _tray = tray_icon::TrayIconBuilder::new()
        .with_tooltip(WINDOW_TITLE)
        .with_icon(tray_icon)
        .with_menu(Box::new(tray_menu))
        .with_menu_on_left_click(false)
        .build()?;

    let weak_tray = weak.clone();
    tray_icon::TrayIconEvent::set_event_handler(Some(move |event| {
        if matches!(event, tray_icon::TrayIconEvent::Click {
            button: tray_icon::MouseButton::Left,
            button_state: tray_icon::MouseButtonState::Up,
            ..
        }) {
            let weak = weak_tray.clone();
            let _ = slint::invoke_from_event_loop(move || {
                if let Some(ui) = weak.upgrade() { let _ = ui.window().show(); }
            });
        }
    }));
    let weak_menu = weak.clone();
    muda::MenuEvent::set_event_handler(Some(move |event: muda::MenuEvent| {
        let weak = weak_menu.clone();
        match event.id.0.as_str() {
            "tray_open" => { let _ = slint::invoke_from_event_loop(move || { if let Some(ui) = weak.upgrade() { let _ = ui.window().show(); } }); }
            "tray_quit" => { let _ = slint::invoke_from_event_loop(move || { let _ = slint::quit_event_loop(); }); }
            _ => {}
        }
    }));

    {
        ui.on_open_panel(move || { let _ = open_target(PANEL_URL); });
        let app_config = Arc::clone(&app);
        ui.on_open_config(move || { let _ = open_target(&AgentConfig::config_dir().to_string_lossy()); });
        ui.on_open_server(move || {
            let app = Arc::clone(&app_config);
            spawn_async(app, |app| async move {
                let path = app.read().await.config.server_dir.clone();
                let _ = open_target(&path.to_string_lossy());
            });
        });
    }

    {
        let app = Arc::clone(&app);
        ui.on_change_server(move |value| {
            let path = PathBuf::from(value.to_string());
            let app = Arc::clone(&app);
            spawn_async(app, move |app| async move {
                if let Err(e) = tokio::fs::create_dir_all(&path).await {
                    app.write().await.add_log("error", format!("No se pudo crear carpeta: {e}"));
                    return;
                }
                let mut config = app.read().await.config.clone();
                config.server_dir = path.clone();
                match tokio::task::spawn_blocking(move || config.save()).await {
                    Ok(Ok(())) => {
                        let mut state = app.write().await;
                        state.config.server_dir = path;
                        state.restart_required = true;
                        state.add_log("warn", "Carpeta del servidor actualizada. Reinicia el Agent.");
                    }
                    Ok(Err(e)) => app.write().await.add_log("error", format!("No se pudo guardar config: {e}")),
                    Err(e) => app.write().await.add_log("error", format!("No se pudo guardar config: {e}")),
                }
            });
        });
    }

    {
        let app = Arc::clone(&app);
        ui.on_copy_pairing(move || {
            let app = Arc::clone(&app);
            spawn_async(app, |app| async move {
                let code = app.read().await.pairing_code.clone().unwrap_or_default();
                if !code.is_empty() {
                    #[cfg(windows)] {
                        use std::os::windows::process::CommandExt;
                        const CREATE_NO_WINDOW: u32 = 0x08000000;
                        if let Ok(mut child) = Command::new("clip").creation_flags(CREATE_NO_WINDOW).stdin(std::process::Stdio::piped()).spawn() {
                            use std::io::Write;
                            if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(code.as_bytes()); }
                        }
                    }
                }
            });
        });
    }

    let app_for_clear = Arc::clone(&app);
    ui.on_clear_logs(move || spawn_async(Arc::clone(&app_for_clear), |app| async move {
        let mut state = app.write().await;
        state.logs.clear();
        state.add_log("info", "Registro de logs limpiado");
    }));

    let app_for_save = Arc::clone(&app);
    ui.on_save_logs(move || spawn_async(Arc::clone(&app_for_save), |app| async move {
        let (dir, text) = {
            let state = app.read().await;
            let lines: Vec<String> = state.logs.iter().map(|l| format!("[{}] {}", l.level, l.message)).collect();
            (AgentConfig::config_dir(), lines.join("\n"))
        };
        let path = dir.join("agent.log");
        if let Err(e) = tokio::fs::write(&path, text).await {
            app.write().await.add_log("error", format!("No se pudieron guardar los logs: {e}"));
        } else {
            app.write().await.add_log("info", format!("Logs guardados en {}", path.display()));
        }
    }));

    let app_for_update = Arc::clone(&app);
    ui.on_check_update(move || spawn_async(Arc::clone(&app_for_update), |app| async move {
        if let Err(e) = crate::check_update_once(Arc::clone(&app)).await {
            app.write().await.add_log("error", format!("Error buscando actualización: {e}"));
        }
    }));

    let app_for_apply = Arc::clone(&app);
    ui.on_apply_update(move || spawn_async(Arc::clone(&app_for_apply), |app| async move {
        let (current, new_exe) = {
            let state = app.read().await;
            (std::env::current_exe().ok(), state.update_file.clone())
        };
        if let (Some(current), Some(new_exe)) = (current, new_exe) {
            match crate::apply_update(&current, &new_exe).await {
                Ok(()) => {
                    {
                        let mut state = app.write().await;
                        state.update_status = "applied".into();
                        state.shutting_down = true;
                        state.add_log("info", "Actualización aplicada. Reiniciando Agent...");
                    }
                    // Cerrar el proceso para que el script .bat pueda arrancar el nuevo ejecutable
                    let _ = slint::invoke_from_event_loop(|| {
                        let _ = slint::quit_event_loop();
                    });
                }
                Err(e) => {
                    let mut state = app.write().await;
                    state.add_log("error", format!("No se pudo aplicar update: {e}"));
                    state.update_status = "error".into();
                    state.update_error = Some(e.to_string());
                }
            }
        } else {
            app.write().await.add_log("error", "No hay archivo de actualización listo para instalar");
        }
    }));

    let app_for_restart = Arc::clone(&app);
    ui.on_restart_agent(move || {
        if let Ok(exe) = std::env::current_exe() { let _ = Command::new(exe).spawn(); }
        spawn_async(Arc::clone(&app_for_restart), |app| async move {
            app.write().await.shutting_down = true;
        });
        let _ = slint::quit_event_loop();
    });

    let weak_for_hide = ui.as_weak();
    ui.on_hide_tray(move || {
        if let Some(ui) = weak_for_hide.upgrade() { let _ = ui.window().hide(); }
    });

    let app_for_quit = Arc::clone(&app);
    ui.on_quit_agent(move || {
        spawn_async(Arc::clone(&app_for_quit), |app| async move {
            let mut state = app.write().await;
            state.shutting_down = true;
            state.add_log("info", "Cierre solicitado desde la interfaz");
        });
        let _ = slint::quit_event_loop();
    });

    let timer = Timer::default();
    let weak_for_timer = weak.clone();
    let app_for_timer = Arc::clone(&app);
    timer.start(TimerMode::Repeated, Duration::from_millis(450), move || {
        let weak = weak_for_timer.clone();
        let app = Arc::clone(&app_for_timer);
        spawn_async(app, move |app| async move {
            let snapshot = app.read().await.snapshot();
            let _ = slint::invoke_from_event_loop(move || {
                if let Some(ui) = weak.upgrade() {
                    ui.set_status_title(if snapshot.cloud_connected { "Conectado".into() } else { "Desconectado".into() });
                    ui.set_status_description(if snapshot.cloud_connected { "Conexión con MoonWolf Cloud activa".into() } else { "Esperando conexión con MoonWolf Cloud".into() });
                    ui.set_cloud_connected(snapshot.cloud_connected);
                    ui.set_local_ready(snapshot.local_server_ready);
                    ui.set_pairing_code(if snapshot.pairing_code.is_empty() { "—".into() } else { snapshot.pairing_code.into() });
                    ui.set_server_dir(snapshot.server_dir.into());
                    ui.set_version(snapshot.version.into());
                    ui.set_agent_id(snapshot.agent_id.into());
                    ui.set_config_dir(snapshot.config_path.into());
                    ui.set_restart_visible(snapshot.restart_required);
                    ui.set_update_visible(snapshot.update_available.is_some());
                    let update = snapshot.update_available.map(|u| format!("Actualización disponible: v{}", u.version)).unwrap_or_else(|| snapshot.update_error.unwrap_or_default());
                    ui.set_update_text(update.into());
                    let logs = snapshot.logs.iter().map(|l| format!("[{}] {}", l.level.to_uppercase(), l.message)).collect::<Vec<_>>().join("\n");
                    ui.set_logs_text(logs.into());
                }
            });
        });
    });

    info!("Iniciando interfaz nativa Slint");
    ui.run()?;
    timer.stop();
    {
        let mut state = app.write().await;
        state.shutting_down = true;
        state.add_log("info", "MoonWolf Agent cerrado");
    }
    Ok(())
}

fn spawn_async<F, Fut>(app: Arc<RwLock<AppState>>, f: F)
where
    F: FnOnce(Arc<RwLock<AppState>>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    std::thread::spawn(move || {
        if let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
            rt.block_on(f(app));
        }
    });
}

fn open_target(target: &str) -> bool {
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new("cmd").args(["/C", "start", "", target]).creation_flags(CREATE_NO_WINDOW).spawn().is_ok()
    }
    #[cfg(not(windows))] { let _ = target; false }
}

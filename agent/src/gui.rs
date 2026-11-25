//! Interfaz nativa de MoonWolf Agent implementada con Slint.

use std::{path::PathBuf, process::Command, sync::Arc};

use slint::ComponentHandle;
use tokio::sync::RwLock;
use tracing::info;

use crate::{AgentConfig, AppState};

slint::include_modules!();

const PANEL_URL: &str = "https://moonwolf-panel.onrender.com";

pub async fn run(app: Arc<RwLock<AppState>>) -> anyhow::Result<()> {
    let ui = MainWindow::new()?;
    let weak = ui.as_weak();
    let tray = TrayIcon::new()?;
    {
        let weak = weak.clone();
        tray.on_open_window(move || {
            if let Some(ui) = weak.upgrade() {
                let _ = ui.window().show();
            }
        });
    }
    tray.on_quit_app(move || {
        let _ = slint::quit_event_loop();
    });

    {
        ui.on_open_panel(move || {
            let _ = open_target(PANEL_URL);
        });
        let app_config = Arc::clone(&app);
        ui.on_open_config(move || {
            let _ = open_target(&AgentConfig::config_dir().to_string_lossy());
        });
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
                    app.write()
                        .await
                        .add_log("error", format!("No se pudo crear carpeta: {e}"));
                    return;
                }
                let mut config = app.read().await.config.clone();
                config.server_dir = path.clone();
                match tokio::task::spawn_blocking(move || config.save()).await {
                    Ok(Ok(())) => {
                        let mut state = app.write().await;
                        state.config.server_dir = path;
                        state.restart_required = true;
                        state.add_log(
                            "warn",
                            "Carpeta del servidor actualizada. Reinicia el Agent.",
                        );
                    }
                    Ok(Err(e)) => app
                        .write()
                        .await
                        .add_log("error", format!("No se pudo guardar config: {e}")),
                    Err(e) => app
                        .write()
                        .await
                        .add_log("error", format!("No se pudo guardar config: {e}")),
                }
            });
        });
    }

    {
        let app = Arc::clone(&app);
        let weak_copy = weak.clone();
        ui.on_copy_pairing(move || {
            let app = Arc::clone(&app);
            let weak = weak_copy.clone();
            spawn_async(app, move |app| async move {
                let code = app.read().await.pairing_code.clone().unwrap_or_default();
                if code.is_empty() {
                    return;
                }
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    const CREATE_NO_WINDOW: u32 = 0x08000000;
                    if let Ok(mut child) = Command::new("clip")
                        .creation_flags(CREATE_NO_WINDOW)
                        .stdin(std::process::Stdio::piped())
                        .spawn()
                    {
                        use std::io::Write;
                        if let Some(mut stdin) = child.stdin.take() {
                            let _ = stdin.write_all(code.as_bytes());
                        }
                    }
                }
                let _ = slint::invoke_from_event_loop({
                    let weak = weak.clone();
                    move || {
                        if let Some(ui) = weak.upgrade() {
                            ui.set_copy_label("Copiado".into());
                        }
                    }
                });
                tokio::time::sleep(std::time::Duration::from_millis(1600)).await;
                let _ = slint::invoke_from_event_loop({
                    let weak = weak.clone();
                    move || {
                        if let Some(ui) = weak.upgrade() {
                            ui.set_copy_label("Copiar".into());
                        }
                    }
                });
            });
        });
    }

    let app_for_clear = Arc::clone(&app);
    ui.on_clear_logs(move || {
        spawn_async(Arc::clone(&app_for_clear), |app| async move {
            let mut state = app.write().await;
            state.logs.clear();
            state.add_log("info", "Registro de logs limpiado");
        })
    });

    let app_for_filter = Arc::clone(&app);
    ui.on_log_filter_changed(move |_| {
        spawn_async(Arc::clone(&app_for_filter), |app| async move {
            let mut state = app.write().await;
            state.gui_revision = state.gui_revision.wrapping_add(1);
        })
    });

    let app_for_save = Arc::clone(&app);
    ui.on_save_logs(move || {
        spawn_async(Arc::clone(&app_for_save), |app| async move {
            let (dir, text) = {
                let state = app.read().await;
                let lines: Vec<String> = state
                    .logs
                    .iter()
                    .map(|l| format!("[{}] {}", l.level, l.message))
                    .collect();
                (AgentConfig::config_dir(), lines.join("\n"))
            };
            let path = dir.join("agent.log");
            if let Err(e) = tokio::fs::write(&path, text).await {
                app.write()
                    .await
                    .add_log("error", format!("No se pudieron guardar los logs: {e}"));
            } else {
                app.write()
                    .await
                    .add_log("info", format!("Logs guardados en {}", path.display()));
            }
        })
    });

    let app_for_update = Arc::clone(&app);
    ui.on_check_update(move || {
        spawn_async(Arc::clone(&app_for_update), |app| async move {
            let _ = crate::check_update_once(app).await;
        })
    });

    let app_for_apply = Arc::clone(&app);
    ui.on_apply_update(move || {
        spawn_async(Arc::clone(&app_for_apply), |app| async move {
            let (current, new_exe, ready) = {
                let state = app.read().await;
                (
                    std::env::current_exe().ok(),
                    state.update_file.clone(),
                    state.update_status == "ready",
                )
            };
            if !ready {
                app.write().await.add_log(
                    "warn",
                    "La actualización todavía no está lista para instalar",
                );
                return;
            }
            if let (Some(current), Some(new_exe)) = (current, new_exe) {
                match crate::apply_update(&current, &new_exe).await {
                    Ok(()) => {
                        {
                            let mut state = app.write().await;
                            state.update_status = "applied".into();
                            state.shutting_down = true;
                            state.add_log("info", "Actualización aplicada. Reiniciando Agent...");
                        }
                        let _ = slint::invoke_from_event_loop(|| {
                            let _ = slint::quit_event_loop();
                        });
                        std::thread::spawn(|| {
                            std::thread::sleep(std::time::Duration::from_millis(1500));
                            std::process::exit(0);
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
                app.write().await.add_log(
                    "error",
                    "No hay archivo de actualización listo para instalar",
                );
            }
        })
    });

    let app_for_restart = Arc::clone(&app);
    ui.on_restart_agent(move || {
        if let Ok(exe) = std::env::current_exe() {
            let _ = Command::new(exe).spawn();
        }
        spawn_async(Arc::clone(&app_for_restart), |app| async move {
            app.write().await.shutting_down = true;
        });
        let _ = slint::quit_event_loop();
    });

    let weak_for_hide = ui.as_weak();
    ui.on_hide_tray(move || {
        if let Some(ui) = weak_for_hide.upgrade() {
            let window = ui.window();
            if window.is_minimized() {
                window.set_minimized(false);
            }
            let _ = window.hide();
        }
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

    let refresh_task = tokio::spawn({
        let app = Arc::clone(&app);
        let weak = weak.clone();
        async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_millis(450));
            let mut last_revision = None;
            loop {
                ticker.tick().await;
                let (revision, snapshot) = {
                    let state = app.read().await;
                    if last_revision == Some(state.gui_revision) {
                        continue;
                    }
                    (state.gui_revision, state.snapshot())
                };
                last_revision = Some(revision);

                let weak = weak.clone();
                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(ui) = weak.upgrade() {
                        ui.set_status_title(if snapshot.cloud_connected {
                            "Conectado".into()
                        } else {
                            "Desconectado".into()
                        });
                        ui.set_status_description(if snapshot.cloud_connected {
                            "Conexión con MoonWolf Cloud activa".into()
                        } else {
                            "Esperando conexión con MoonWolf Cloud".into()
                        });
                        ui.set_cloud_connected(snapshot.cloud_connected);
                        ui.set_local_ready(snapshot.local_server_ready);
                        ui.set_pairing_code(if snapshot.pairing_code.is_empty() {
                            "—".into()
                        } else {
                            snapshot.pairing_code.into()
                        });
                        ui.set_server_dir(snapshot.server_dir.into());
                        ui.set_version(snapshot.version.into());
                        ui.set_config_dir(snapshot.config_path.into());
                        ui.set_restart_visible(snapshot.restart_required);
                        let has_update = snapshot.update_available.is_some();
                        let update_version = snapshot
                            .update_available
                            .as_ref()
                            .map(|u| u.version.as_str())
                            .unwrap_or("");
                        let update_ready = has_update && snapshot.update_status == "ready";
                        let update_failed = has_update && snapshot.update_status == "error";
                        ui.set_update_visible(has_update);
                        ui.set_update_installable(update_ready);
                        ui.set_update_failed(update_failed);
                        let update = if has_update {
                            match snapshot.update_status.as_str() {
                                "downloading" | "checking" => format!(
                                    "Descargando v{update_version}: {:.0}%",
                                    snapshot.update_progress * 100.0
                                ),
                                "ready" => format!("Actualización lista: v{update_version}"),
                                "error" => snapshot
                                    .update_error
                                    .clone()
                                    .unwrap_or_else(|| "Error preparando la actualización".into()),
                                _ => format!("Actualización disponible: v{update_version}"),
                            }
                        } else {
                            snapshot.update_error.clone().unwrap_or_default()
                        };
                        ui.set_update_text(update.into());
                        let filter = ui.get_log_filter();
                        let logs = snapshot
                            .logs
                            .iter()
                            .filter(|l| match filter {
                                1 => l.level == "info",
                                2 => l.level == "warn",
                                3 => l.level == "error",
                                _ => true,
                            })
                            .map(|l| format!("[{}] {}", l.level.to_uppercase(), l.message))
                            .collect::<Vec<_>>()
                            .join("\n");
                        ui.set_logs_text(logs.into());
                    }
                });
            }
        }
    });

    info!("Iniciando interfaz nativa Slint");
    ui.show()?;
    let ui_result = slint::run_event_loop_until_quit();
    refresh_task.abort();
    let _ = refresh_task.await;
    ui_result?;
    {
        let mut state = app.write().await;
        state.shutting_down = true;
        state.add_log("info", "MoonWolf Agent cerrado");
    }
    drop(tray);
    Ok(())
}

fn spawn_async<F, Fut>(app: Arc<RwLock<AppState>>, f: F)
where
    F: FnOnce(Arc<RwLock<AppState>>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    std::thread::spawn(move || {
        if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            rt.block_on(f(app));
        }
    });
}

fn open_target(target: &str) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new("cmd")
            .args(["/C", "start", "", target])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .is_ok()
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        false
    }
}

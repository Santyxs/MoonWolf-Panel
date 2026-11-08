//! Interfaz gráfica con WebView (wry + tao).

use std::path::PathBuf;
use std::sync::Arc;

use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use tokio::sync::RwLock;
use tracing::{error, info};
use wry::WebViewBuilder;

use crate::{AgentConfig, AppState};

const WINDOW_TITLE: &str = "MoonWolf Agent";
const PANEL_URL: &str = "https://moonwolf-panel.onrender.com";

const UI_HTML: &str = include_str!("../ui/index.html");
const UI_CSS: &str = include_str!("../ui/style.css");
const UI_JS: &str = include_str!("../ui/app.js");
const TRAY_ICON_PNG: &[u8] = include_bytes!("../assets/tray.png");

const NATIVE_BRIDGE: &str = r#"
(function () {
  function post(action, extra) {
    var payload = Object.assign({ action: action }, extra || {});
    var msg = JSON.stringify(payload);
    try {
      if (window.ipc && window.ipc.postMessage) {
        window.ipc.postMessage(msg);
        return;
      }
    } catch (e) {}
    try {
      if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
        window.chrome.webview.postMessage(msg);
        return;
      }
    } catch (e) {}
  }
  var lastState = null;
  window.__applyState = function (json) {
    try {
      var state = typeof json === 'string' ? JSON.parse(json) : json;
      lastState = state;
      window.dispatchEvent(new CustomEvent('moonwolf-state', { detail: state }));
    } catch (e) {
      console.error(e);
    }
  };
  window.native = {
    getState: function () { return lastState || {}; },
    openPanel: function () { post('open_panel'); return { ok: true }; },
    openServerFolder: function () { post('open_server_folder'); return { ok: true }; },
    openConfig: function () { post('open_config_dir'); return { ok: true }; },
    setServerDir: function (dir) {
      post('set_server_dir', { path: dir });
      return Promise.resolve({ ok: true, restartRequired: true });
    },
    clearLogs: function () { post('clear_logs'); return true; },
    saveLogs: function () { post('save_logs'); return true; },
    hideToTray: function () { post('hide_to_tray'); return { ok: true }; },
    restart: function () { post('restart'); return true; },
    checkForUpdates: function () {
      post('check_update');
      return Promise.resolve({ ok: true });
    },
    applyUpdate: function () {
      post('apply_update');
      return Promise.resolve({ ok: true });
    },
    close: function () { post('quit'); return { ok: true }; }
  };
})();
"#;

#[derive(Debug)]
enum GuiEvent {
    StateJson(String),
    MinimizeToTray,
    RestoreFromTray,
    Quit,
}

fn assemble_ui() -> String {
    let mut html = UI_HTML.to_string();

    html = html.replace("<link rel=\"stylesheet\" href=\"style.css\">", "");
    html = html.replace("<link rel='stylesheet' href='style.css'>", "");
    html = html.replace("<script src=\"app.js\"></script>", "");
    html = html.replace("<script src='app.js'></script>", "");

    if let Some(pos) = html.find("</head>") {
        let style_tag = format!("<style>\n{}\n</style>\n", UI_CSS);
        html.insert_str(pos, &style_tag);
    }

    if let Some(pos) = html.rfind("</body>") {
        let scripts = format!(
            "<script>\n{}\n</script>\n<script>\n{}\n</script>\n",
            NATIVE_BRIDGE, UI_JS
        );
        html.insert_str(pos, &scripts);
    }

    html
}

fn setup_webview2_data_dir() {
    #[cfg(windows)]
    {
        let dir = AgentConfig::config_dir().join("WebView2");
        let _ = std::fs::create_dir_all(&dir);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);
        info!("WebView2 data folder: {}", dir.display());
    }
}

pub async fn run(app: Arc<RwLock<AppState>>) -> anyhow::Result<()> {
    setup_webview2_data_dir();

    let index_html = assemble_ui();
    let event_loop = EventLoopBuilder::<GuiEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    {
        let app = Arc::clone(&app);
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("rt");
            rt.block_on(async move {
                let mut last = String::new();
                loop {
                    {
                        let s = app.read().await;
                        if s.shutting_down {
                            let _ = proxy.send_event(GuiEvent::Quit);
                            break;
                        }
                        if let Ok(json) = serde_json::to_string(&s.snapshot()) {
                            if json != last {
                                last = json.clone();
                                let _ = proxy.send_event(GuiEvent::StateJson(json));
                            }
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                }
            });
        });
    }

    let window_icon = image::load_from_memory(TRAY_ICON_PNG)
        .ok()
        .map(|img| {
            let rgba = img.into_rgba8();
            let (w, h) = image::GenericImageView::dimensions(&rgba);
            tao::window::Icon::from_rgba(rgba.into_raw(), w, h).ok()
        })
        .flatten();

    let window = WindowBuilder::new()
        .with_title(WINDOW_TITLE)
        .with_inner_size(tao::dpi::LogicalSize::new(420u32, 570u32))
        .with_min_inner_size(tao::dpi::LogicalSize::new(380u32, 500u32))
        .with_window_icon(window_icon)
        .with_resizable(true)
        .build(&event_loop)?;

    let tray_menu = muda::Menu::new();
    let item_open = muda::MenuItem::with_id("tray_open", "Abrir MoonWolf Agent", true, None);
    let item_quit = muda::MenuItem::with_id("tray_quit", "Salir", true, None);
    let _ = tray_menu.append(&item_open);
    let _ = tray_menu.append(&muda::PredefinedMenuItem::separator());
    let _ = tray_menu.append(&item_quit);

    let tray_icon_img = image::load_from_memory(TRAY_ICON_PNG)
        .ok()
        .and_then(|img| {
            let rgba = img.into_rgba8();
            let (w, h) = image::GenericImageView::dimensions(&rgba);
            tray_icon::Icon::from_rgba(rgba.into_raw(), w, h).ok()
        });

    let mut tray_builder = tray_icon::TrayIconBuilder::new()
        .with_tooltip(WINDOW_TITLE)
        .with_menu(Box::new(tray_menu))
        .with_menu_on_left_click(false);

    if let Some(ti) = tray_icon_img {
        tray_builder = tray_builder.with_icon(ti);
    }

    let _tray_icon = match tray_builder.build() {
        Ok(t) => {
            info!("Bandeja del sistema inicializada");
            Some(t)
        }
        Err(e) => {
            error!("Error inicializando bandeja: {e}");
            None
        }
    };

    {
        let proxy = proxy.clone();
        tray_icon::TrayIconEvent::set_event_handler(Some(move |event: tray_icon::TrayIconEvent| {
            if let tray_icon::TrayIconEvent::Click {
                button: tray_icon::MouseButton::Left,
                button_state: tray_icon::MouseButtonState::Up,
                ..
            } = event
            {
                let _ = proxy.send_event(GuiEvent::RestoreFromTray);
            }
        }));
    }

    {
        let proxy = proxy.clone();
        muda::MenuEvent::set_event_handler(Some(move |event: muda::MenuEvent| {
            if event.id.0 == "tray_open" {
                let _ = proxy.send_event(GuiEvent::RestoreFromTray);
            } else if event.id.0 == "tray_quit" {
                let _ = proxy.send_event(GuiEvent::Quit);
            }
        }));
    }

    let app_for_ipc = Arc::clone(&app);
    let proxy_for_ipc = proxy.clone();

    let webview = WebViewBuilder::new(&window)
        .with_html(&index_html)
        .with_ipc_handler(move |req| {
            let body = req.body().clone();
            handle_ipc(body, Arc::clone(&app_for_ipc), proxy_for_ipc.clone());
        })
        .build()?;

    info!("Ventana GUI lista");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(GuiEvent::StateJson(json)) => {
                let safe = json
                    .replace('\u{2028}', "\\u2028")
                    .replace('\u{2029}', "\\u2029");
                let script = format!("window.__applyState && window.__applyState({safe});");
                if let Err(e) = webview.evaluate_script(&script) {
                    error!("evaluate_script: {e}");
                }
            }
            Event::UserEvent(GuiEvent::Quit) => {
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(GuiEvent::MinimizeToTray) => {
                window.set_visible(false);
            }
            Event::UserEvent(GuiEvent::RestoreFromTray) => {
                window.set_visible(true);
                window.set_minimized(false);
                window.set_focus();
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                mark_shutdown(Arc::clone(&app));
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

fn mark_shutdown(app: Arc<RwLock<AppState>>) {
    if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        rt.block_on(async {
            let mut s = app.write().await;
            s.shutting_down = true;
        });
    }
}

fn handle_ipc(
    body: String,
    app: Arc<RwLock<AppState>>,
    proxy: tao::event_loop::EventLoopProxy<GuiEvent>,
) {
    let body = body.trim().to_string();
    let (action, path_arg) = if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
        (
            v.get("action")
                .and_then(|a| a.as_str())
                .unwrap_or("")
                .to_string(),
            v.get("path")
                .and_then(|p| p.as_str())
                .map(|s| s.to_string()),
        )
    } else {
        (body.clone(), None)
    };

    match action.as_str() {
        "quit" | "close" => {
            spawn_async(app, |app| async move {
                let mut s = app.write().await;
                s.shutting_down = true;
                s.add_log("info", "Cierre solicitado desde la interfaz");
            });
            let _ = proxy.send_event(GuiEvent::Quit);
        }
        "open_panel" => {
            let _ = open_url(PANEL_URL);
        }
        "open_config_dir" | "open_config" => {
            let dir = AgentConfig::config_dir();
            let _ = open_path(&dir);
        }
        "open_server_folder" => {
            spawn_async(app, |app| async move {
                let dir = {
                    let s = app.read().await;
                    s.config.server_dir.clone()
                };
                let _ = open_path(&dir);
            });
        }
        "set_server_dir" => {
            if let Some(dir) = path_arg {
                spawn_async(app, move |app| async move {
                    let mut s = app.write().await;
                    let path = PathBuf::from(&dir);
                    if let Err(e) = std::fs::create_dir_all(&path) {
                        s.add_log("error", format!("No se pudo crear carpeta: {e}"));
                        return;
                    }
                    s.config.server_dir = path;
                    if let Err(e) = s.config.save() {
                        s.add_log("error", format!("No se pudo guardar config: {e}"));
                    } else {
                        s.restart_required = true;
                        s.add_log(
                            "warn",
                            "Carpeta del servidor actualizada. Reinicia el Agent.",
                        );
                    }
                });
            }
        }
        "clear_logs" => {
            spawn_async(app, |app| async move {
                let mut s = app.write().await;
                s.logs.clear();
                s.add_log("info", "Registro de logs limpiado");
            });
        }
        "save_logs" => {
            spawn_async(app, |app| async move {
                let (dir, text) = {
                    let s = app.read().await;
                    let lines: Vec<String> = s
                        .logs
                        .iter()
                        .map(|l| format!("[{}] {}", l.level, l.message))
                        .collect();
                    (AgentConfig::config_dir(), lines.join("\n"))
                };
                let path = dir.join("agent.log");
                let _ = std::fs::write(&path, text);
                let mut s = app.write().await;
                s.add_log("info", format!("Logs guardados en {}", path.display()));
            });
        }
        "check_update" => {
            spawn_async(app, |app| async move {
                if let Err(e) = crate::check_update_once(Arc::clone(&app)).await {
                    let mut s = app.write().await;
                    s.add_log("error", format!("Error buscando actualización: {e}"));
                }
            });
        }
        "apply_update" => {
            spawn_async(app, |app| async move {
                let (current, new_exe) = {
                    let s = app.read().await;
                    (std::env::current_exe().ok(), s.update_file.clone())
                };
                if let (Some(cur), Some(new_path)) = (current, new_exe) {
                    if let Err(e) = crate::apply_update(&cur, &new_path).await {
                        let mut s = app.write().await;
                        s.add_log("error", format!("No se pudo aplicar update: {e}"));
                    } else {
                        let mut s = app.write().await;
                        s.shutting_down = true;
                        s.add_log("info", "Actualización aplicada. Reiniciando…");
                    }
                } else {
                    let mut s = app.write().await;
                    s.add_log("error", "No hay actualización lista para aplicar");
                }
            });
        }
        "restart" => {
            if let Ok(exe) = std::env::current_exe() {
                let _ = std::process::Command::new(&exe).spawn();
            }
            spawn_async(app, |app| async move {
                let mut s = app.write().await;
                s.shutting_down = true;
            });
            let _ = proxy.send_event(GuiEvent::Quit);
        }
        "hide_to_tray" => {
            info!("hide_to_tray / minimizar a segundo plano solicitado");
            let _ = proxy.send_event(GuiEvent::MinimizeToTray);
        }
        other if !other.is_empty() => {
            tracing::debug!("IPC action: {other}");
        }
        _ => {}
    }
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

fn open_url(url: &str) -> bool {
    open_path_str(url)
}

fn open_path(path: &std::path::Path) -> bool {
    open_path_str(&path.to_string_lossy())
}

fn open_path_str(target: &str) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", target])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .is_ok()
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(target).spawn().is_ok()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(target).spawn().is_ok()
    }
}

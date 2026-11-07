//! Interfaz gráfica con WebView (wry + tao).
//! UI = HTML/CSS/JS del agent Node original + bridge window.native → IPC.

use std::path::PathBuf;
use std::sync::Arc;

use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use tokio::sync::RwLock;
use tracing::{error, info};
use wry::WebViewBuilder;

use crate::state::AppState;

const WINDOW_TITLE: &str = "MoonWolf Agent";
const PANEL_URL: &str = "https://moonwolf-panel.onrender.com";

const UI_BODY: &str = include_str!("../ui/body.html");
const UI_CSS: &str = include_str!("../ui/style.css");
const UI_JS: &str = include_str!("../ui/app.js");

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
    Quit,
}

fn build_index_html() -> String {
    let mut out = String::with_capacity(
        UI_CSS.len() + UI_BODY.len() + UI_JS.len() + NATIVE_BRIDGE.len() + 512,
    );
    out.push_str("<!DOCTYPE html>\n<html lang=\"es\">\n<head>\n");
    out.push_str("<meta charset=\"UTF-8\">\n");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    out.push_str("<title>MoonWolf Agent</title>\n<style>\n");
    out.push_str(UI_CSS);
    out.push_str("\n</style>\n</head>\n<body>\n");
    out.push_str(UI_BODY);
    out.push_str("\n<script>\n");
    out.push_str(NATIVE_BRIDGE);
    out.push_str("\n</script>\n<script>\n");
    out.push_str(UI_JS);
    out.push_str("\n</script>\n</body>\n</html>\n");
    out
}

fn setup_webview2_data_dir() {
    #[cfg(windows)]
    {
        let dir = crate::config::AgentConfig::config_dir().join("WebView2");
        let _ = std::fs::create_dir_all(&dir);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);
        info!("WebView2 data folder: {}", dir.display());
    }
}

pub async fn run(app: Arc<RwLock<AppState>>) -> anyhow::Result<()> {
    setup_webview2_data_dir();

    let index_html = load_ui_index();
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

    let window = WindowBuilder::new()
        .with_title(WINDOW_TITLE)
        .with_inner_size(tao::dpi::LogicalSize::new(420u32, 720u32))
        .with_min_inner_size(tao::dpi::LogicalSize::new(380u32, 600u32))
        .with_resizable(true)
        .build(&event_loop)?;

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
            let dir = crate::config::AgentConfig::config_dir();
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
                    (crate::config::AgentConfig::config_dir(), lines.join("\n"))
                };
                let path = dir.join("agent.log");
                let _ = std::fs::write(&path, text);
                let mut s = app.write().await;
                s.add_log("info", format!("Logs guardados en {}", path.display()));
            });
        }
        "check_update" => {
            spawn_async(app, |app| async move {
                if let Err(e) = crate::update::check_once(Arc::clone(&app)).await {
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
                    if let Err(e) = crate::update::apply_update(&cur, &new_path).await {
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
            info!("hide_to_tray solicitado (bandeja aún no implementada en Rust)");
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

fn load_ui_index() -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("ui").join("index.html");
            if let Ok(html) = std::fs::read_to_string(&p) {
                info!("UI cargada desde {}", p.display());
                return html;
            }
        }
    }
    info!("UI ensamblada (HTML/CSS/JS originales + bridge)");
    build_index_html()
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

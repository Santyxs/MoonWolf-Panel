//! Interfaz gráfica con WebView (wry + tao).

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
const EMBEDDED_UI: &str = include_str!("../ui/index.html");

#[derive(Debug)]
enum GuiEvent {
    StateJson(String),
    Quit,
}

pub async fn run(app: Arc<RwLock<AppState>>) -> anyhow::Result<()> {
    let index_html = load_ui_index();
    let event_loop = EventLoopBuilder::<GuiEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // Hilo que empuja el estado a la UI cada 500 ms
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
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            });
        });
    }

    let window = WindowBuilder::new()
        .with_title(WINDOW_TITLE)
        .with_inner_size(tao::dpi::LogicalSize::new(560u32, 680u32))
        .with_min_inner_size(tao::dpi::LogicalSize::new(480u32, 560u32))
        .with_resizable(true)
        .build(&event_loop)?;

    let app_for_ipc = Arc::clone(&app);
    let proxy_for_ipc = proxy.clone();

    let webview = WebViewBuilder::new(&window)
        .with_html(&index_html)
        .with_ipc_handler(move |req| {
            // wry 0.45: Request<String> — el body es el mensaje JS
            let body = req.body().clone();
            handle_ipc(body, Arc::clone(&app_for_ipc), proxy_for_ipc.clone());
        })
        .build()?;

    info!("Ventana GUI lista");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(GuiEvent::StateJson(json)) => {
                // Pasar JSON escapado como string literal a __applyState
                let escaped = serde_json::to_string(&json).unwrap_or_else(|_| "\"{}\"".into());
                let script = format!("window.__applyState && window.__applyState({escaped})");
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
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    let app = Arc::clone(&app);
                    rt.block_on(async {
                        let mut s = app.write().await;
                        s.shutting_down = true;
                    });
                }
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

fn handle_ipc(body: String, app: Arc<RwLock<AppState>>, proxy: tao::event_loop::EventLoopProxy<GuiEvent>) {
    let body = body.trim().to_string();
    // Aceptar texto plano o JSON
    let action = if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
        v.get("action")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string()
    } else {
        body.clone()
    };

    match action.as_str() {
        "quit" => {
            spawn_async(app, |app| async move {
                let mut s = app.write().await;
                s.shutting_down = true;
                s.add_log("info", "Cierre solicitado desde la interfaz");
            });
            let _ = proxy.send_event(GuiEvent::Quit);
        }
        "open_panel" => {
            let _ = open_url("https://moonwolf-panel.onrender.com");
        }
        "open_config_dir" => {
            let dir = crate::config::AgentConfig::config_dir();
            let _ = open_path(&dir);
        }
        "check_update" => {
            spawn_async(app, |app| async move {
                if let Err(e) = crate::update::check_once(Arc::clone(&app)).await {
                    let mut s = app.write().await;
                    s.add_log("error", format!("Error buscando actualización: {e}"));
                }
            });
        }
        "copy_pairing" => {
            spawn_async(app, |app| async move {
                let mut s = app.write().await;
                s.add_log("info", "Código de emparejamiento copiado");
            });
        }
        "clear_logs" => {
            spawn_async(app, |app| async move {
                let mut s = app.write().await;
                s.logs.clear();
                s.add_log("info", "Registro de logs limpiado");
            });
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
    info!("UI embebida en el binario");
    EMBEDDED_UI.to_string()
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

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

#[derive(Debug)]
enum GuiEvent {
    StateJson(String),
    Quit,
}

pub async fn run(app: Arc<RwLock<AppState>>) -> anyhow::Result<()> {
    let index_html = load_ui_index()?;
    let event_loop = EventLoopBuilder::<GuiEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    {
        let app = Arc::clone(&app);
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("rt");
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
        .with_inner_size(tao::dpi::LogicalSize::new(620u32, 720u32))
        .with_min_inner_size(tao::dpi::LogicalSize::new(560u32, 650u32))
        .with_resizable(true)
        .build(&event_loop)?;

    let app_for_ipc = Arc::clone(&app);
    let webview = WebViewBuilder::new()
        .with_html(&index_html)
        .with_ipc_handler(move |req| {
            let body = req.body().to_string();
            let app = Arc::clone(&app_for_ipc);
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&body) {
                let action = msg.get("action").and_then(|a| a.as_str()).unwrap_or("");
                match action {
                    "quit" => {
                        std::thread::spawn(move || {
                            if let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
                                rt.block_on(async {
                                    let mut s = app.write().await;
                                    s.shutting_down = true;
                                    s.add_log("info", "Cierre solicitado desde la interfaz");
                                });
                            }
                        });
                    }
                    "clear_logs" => {
                        std::thread::spawn(move || {
                            if let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
                                rt.block_on(async {
                                    let mut s = app.write().await;
                                    s.logs.clear();
                                    s.add_log("info", "Registro de logs limpiado");
                                });
                            }
                        });
                    }
                    "set_server_dir" => {
                        if let Some(dir) = msg.get("path").and_then(|p| p.as_str()) {
                            let dir = dir.to_string();
                            std::thread::spawn(move || {
                                if let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
                                    rt.block_on(async {
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
                                            s.add_log("warn", "Carpeta del servidor actualizada. Reinicia el Agent.");
                                        }
                                    });
                                }
                            });
                        }
                    }
                    "open_panel" => { let _ = open_url("https://moonwolf-panel.onrender.com"); }
                    "open_config_dir" => {
                        let dir = crate::config::AgentConfig::config_dir();
                        let _ = open_path(&dir);
                    }
                    "check_update" => {
                        let app2 = Arc::clone(&app);
                        std::thread::spawn(move || {
                            if let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
                                rt.block_on(async {
                                    if let Err(e) = crate::update::check_once(app2).await {
                                        let mut s = app.write().await;
                                        s.add_log("error", format!("Error buscando actualización: {e}"));
                                    }
                                });
                            }
                        });
                    }
                    other => tracing::debug!("IPC action desconocida: {other}"),
                }
            }
        })
        .build(&window)?;

    info!("Ventana GUI lista");
    let _ = webview.evaluate_script(r#"
        window.__moonwolfAgent = {
            post: (obj) => window.ipc.postMessage(JSON.stringify(obj)),
            onState: null,
        };
        window.__applyState = (json) => {
            try {
                const state = typeof json === 'string' ? JSON.parse(json) : json;
                if (typeof window.__moonwolfAgent.onState === 'function') window.__moonwolfAgent.onState(state);
                window.dispatchEvent(new CustomEvent('moonwolf-state', { detail: state }));
            } catch (e) { console.error(e); }
        };
    "#);

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(GuiEvent::StateJson(json)) => {
                let script = format!("window.__applyState && window.__applyState({});", json);
                if let Err(e) = webview.evaluate_script(&script) {
                    error!("evaluate_script: {e}");
                }
            }
            Event::UserEvent(GuiEvent::Quit) => { *control_flow = ControlFlow::Exit; }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
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

fn load_ui_index() -> anyhow::Result<String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("ui").join("index.html");
            if p.exists() {
                return Ok(std::fs::read_to_string(p)?);
            }
        }
    }
    let dev = PathBuf::from("ui/index.html");
    if dev.exists() {
        return Ok(std::fs::read_to_string(dev)?);
    }
    Ok(r#"<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>MoonWolf Agent</title>
<style>body{font-family:system-ui;background:#0b1020;color:#e8eefc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#141b2d;padding:2rem;border-radius:16px;text-align:center}h1{margin:0 0 .5rem}</style></head>
<body><div class="card"><h1>MoonWolf Agent</h1><p>Rust · sin Node.js</p></div>
<script>window.__moonwolfAgent={post:o=>window.ipc.postMessage(JSON.stringify(o))};</script></body></html>"#.into())
}

fn open_url(url: &str) -> bool { open_path_str(url) }
fn open_path(path: &std::path::Path) -> bool { open_path_str(&path.to_string_lossy()) }

fn open_path_str(target: &str) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("explorer.exe").arg(target).creation_flags(CREATE_NO_WINDOW).spawn().is_ok()
    }
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg(target).spawn().is_ok() }
    #[cfg(all(unix, not(target_os = "macos")))]
    { std::process::Command::new("xdg-open").arg(target).spawn().is_ok() }
}

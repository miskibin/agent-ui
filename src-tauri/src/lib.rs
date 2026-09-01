//! Agent UI desktop shell.
//!
//! The web app is not embedded as static files: it is the real Next.js
//! standalone server, shipped inside the bundle together with a Node runtime
//! and started as a Tauri sidecar on a free loopback port. The window stays
//! hidden until that server answers, so the user never sees a blank frame.
//!
//! In development (`tauri dev`) the sidecar is skipped entirely — `next dev`
//! is already running behind `build.devUrl`.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewWindow, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Path of the Next.js standalone entry point inside the bundled resources.
/// `bundle.resources` keeps the source-relative layout, hence the prefix.
const SERVER_ENTRY: &str = "resources/app/server.js";

/// Route that only answers once Next.js has finished booting its router.
const HEALTH_PATH: &str = "/api/providers";

/// Give up (and show a readable error) if the server is not up by then.
const READY_TIMEOUT: Duration = Duration::from_secs(15);

/// Gap between health probes. Small enough that a warm start feels instant.
const PROBE_INTERVAL: Duration = Duration::from_millis(40);

/// If the server is unusually slow, surface the (dark) splash instead of
/// leaving the user with no window at all.
const SPLASH_AFTER: Duration = Duration::from_millis(1200);

/// Number of trailing sidecar log bytes kept for the failure screen.
const LOG_TAIL_BYTES: usize = 4096;

/// Owns the Node child process. Managed state, so it is killed on app exit
/// (explicitly on close/exit events, and via `Drop` as a backstop).
#[derive(Default)]
struct Sidecar(Mutex<Option<CommandChild>>);

impl Sidecar {
    fn store(&self, child: CommandChild) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(child);
        }
    }

    fn kill(&self) {
        let child = self.0.lock().ok().and_then(|mut slot| slot.take());
        if let Some(child) = child {
            let _ = child.kill();
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Rolling tail of the sidecar's stdout/stderr, shown if startup fails.
#[derive(Clone, Default)]
struct LogTail(Arc<Mutex<String>>);

impl LogTail {
    fn push(&self, line: &str) {
        if let Ok(mut buf) = self.0.lock() {
            buf.push_str(line);
            buf.push('\n');
            if buf.len() > LOG_TAIL_BYTES {
                // Keep the tail, trimmed forward to a char boundary.
                let cut = buf.len() - LOG_TAIL_BYTES;
                let cut = (cut..buf.len())
                    .find(|i| buf.is_char_boundary(*i))
                    .unwrap_or(buf.len());
                buf.replace_range(..cut, "");
            }
        }
    }

    fn snapshot(&self) -> String {
        self.0
            .lock()
            .map(|buf| buf.trim().to_string())
            .unwrap_or_default()
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(Sidecar::default());

            let window = app
                .get_webview_window("main")
                .expect("`main` window is declared in tauri.conf.json");

            if tauri::is_dev() {
                // `beforeDevCommand` already started `next dev`. The window's
                // configured `index.html` would 404 against the dev server,
                // so go straight to `build.devUrl`.
                if let Some(url) = app.config().build.dev_url.clone() {
                    window.navigate(url)?;
                }
                window.show()?;
            } else {
                start_app_server(app.handle().clone(), window)?;
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start the Agent UI shell");

    app.run(|handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            handle.state::<Sidecar>().kill();
        }
        RunEvent::WindowEvent {
            event: WindowEvent::CloseRequested { .. },
            ..
        } => {
            handle.state::<Sidecar>().kill();
        }
        _ => {}
    });
}

/// Spawns the bundled Node server and, once it answers, points the window at
/// it. Returns as soon as the child is running; the wait happens off-thread so
/// the event loop starts immediately.
fn start_app_server(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), Box<dyn std::error::Error>> {
    let port = free_port()?;
    let server = app.path().resolve(SERVER_ENTRY, BaseDirectory::Resource)?;
    let app_dir = server
        .parent()
        .ok_or("bundled server.js has no parent directory")?
        .to_path_buf();

    // Opened before the spawn so a startup failure reports the path that was
    // actually resolved, rather than only what Node made of it.
    let log = LogTail::default();
    log.push(&format!("server entry: {}", server.display()));
    if !server.is_file() {
        log.push(&format!(
            "no file at that path — expected the bundle to carry {SERVER_ENTRY}"
        ));
    }

    // Node is given the bare file name resolved against `current_dir`, never
    // the absolute path. An absolute Windows path carries a drive prefix, and
    // as the main-module argument it can end up read as drive-relative — Node
    // then resolves the root alone (`C:`) and dies in `realpathSync` before it
    // ever reaches server.js.
    let entry = server
        .file_name()
        .ok_or("bundled server.js has no file name")?
        .to_os_string();

    let (mut events, child) = app
        .shell()
        .sidecar("node")?
        .arg(&entry)
        .current_dir(&app_dir)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .spawn()?;

    app.state::<Sidecar>().store(child);

    // The sidecar event channel is bounded: leaving it unread would stall the
    // child once its stdout pipe fills. Drain it and keep the tail for errors.
    std::thread::spawn({
        let log = log.clone();
        move || {
            while let Some(event) = events.blocking_recv() {
                match event {
                    CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                        log.push(String::from_utf8_lossy(&line).trim_end());
                    }
                    CommandEvent::Error(err) => log.push(&err),
                    CommandEvent::Terminated(payload) => {
                        log.push(&format!("server exited with code {:?}", payload.code));
                    }
                    _ => {}
                }
            }
        }
    });

    std::thread::spawn(move || {
        let started = Instant::now();
        let mut splash_shown = false;

        loop {
            if probe(port) {
                break;
            }
            if started.elapsed() >= READY_TIMEOUT {
                show_failure(&window, port, &log.snapshot());
                return;
            }
            if !splash_shown && started.elapsed() >= SPLASH_AFTER {
                splash_shown = true;
                let _ = window.show();
            }
            std::thread::sleep(PROBE_INTERVAL);
        }

        match Url::parse(&format!("http://127.0.0.1:{port}/")) {
            Ok(url) => {
                if let Err(err) = window.navigate(url) {
                    show_failure(&window, port, &err.to_string());
                    return;
                }
            }
            Err(err) => {
                show_failure(&window, port, &err.to_string());
                return;
            }
        }

        // Both the splash and the window background are the app's dark
        // neutral, so revealing here cannot flash white.
        let _ = window.show();
        let _ = window.set_focus();
    });

    Ok(())
}

/// Reserves a loopback port by binding to :0 and immediately releasing it.
fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// True once the server returns any HTTP status line — a 500 from the health
/// route still means Next.js is listening and routing, which is what we wait
/// for. Connection refused / timeout is the "not ready yet" signal.
fn probe(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));

    let request = format!(
        "GET {HEALTH_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut status = String::new();
    if BufReader::new(stream).read_line(&mut status).is_err() {
        return false;
    }
    status.starts_with("HTTP/1.")
}

/// Reveals the window with a readable error instead of hanging invisibly.
fn show_failure(window: &WebviewWindow, port: u16, detail: &str) {
    let detail = if detail.is_empty() {
        "The server produced no output.".to_string()
    } else {
        detail.to_string()
    };
    let message = format!(
        "The bundled server did not answer on http://127.0.0.1:{port} within {}s.\n\n{detail}",
        READY_TIMEOUT.as_secs()
    );
    if let Ok(json) = serde_json::to_string(&message) {
        let _ = window.eval(format!("window.__agentUiError({json})"));
    }
    let _ = window.show();
    let _ = window.set_focus();
}

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

/// Platform-specific sidecar file names. Tauri places externalBin next to the
/// main executable, with a `.exe` suffix on Windows.
#[cfg(windows)]
mod plat {
    pub const VN: &str = "vn.exe";
    pub const BUN: &str = "bun.exe";
    pub const FFPROBE: &str = "ffprobe.exe";
}
#[cfg(not(windows))]
mod plat {
    pub const VN: &str = "vn";
    pub const BUN: &str = "bun";
    pub const FFPROBE: &str = "ffprobe";
}

/// Env the bundled engine needs to find its sibling runtimes. Dev resolves pi /
/// ffprobe from PATH; release points vn at the bundled bun + pi cli.js. pi can't
/// be --compile'd (it reads data files from disk) but runs fine as
/// `<bun> <pi/dist/cli.js>`; vn honors VOICENOTE_PI_CLI by invoking pi that way
/// directly — no wrapper script, no shell, identical on macOS and Windows.
fn engine_env(app: &AppHandle) -> Vec<(String, String)> {
    if cfg!(debug_assertions) {
        return vec![];
    }
    let mut env = Vec::new();
    // bun + ffprobe are externalBin sidecars next to the app binary; pi is a data resource.
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let res_dir = app.path().resource_dir().ok();
    if let (Some(exe_dir), Some(res_dir)) = (exe_dir, res_dir) {
        let bun = exe_dir.join(plat::BUN);
        let pi_cli = res_dir.join("resources/pi/dist/cli.js");
        if let (true, true, Some(b), Some(c)) =
            (bun.exists(), pi_cli.exists(), bun.to_str(), pi_cli.to_str())
        {
            env.push(("VOICENOTE_PI_BIN".to_string(), b.to_string()));
            env.push(("VOICENOTE_PI_CLI".to_string(), c.to_string()));
        }
        let ffprobe = exe_dir.join(plat::FFPROBE);
        if let (true, Some(p)) = (ffprobe.exists(), ffprobe.to_str()) {
            env.push(("VOICENOTE_FFPROBE_BIN".to_string(), p.to_string()));
        }
    }
    env
}

fn apply_engine_env(cmd: &mut Command, app: &AppHandle) {
    for (k, v) in engine_env(app) {
        cmd.env(k, v);
    }
}

/// Resolve how to invoke the voicenote engine.
///
/// - Debug (dev): run the local TypeScript source via `bun`, located relative
///   to this crate so it never hardcodes a machine-specific path. The globally
///   installed `vn` may be an older published build without `vn login`.
/// - Release (bundled): use the `vn` sidecar next to the app executable.
fn vn_command() -> (String, Vec<String>) {
    if cfg!(debug_assertions) {
        let manifest = env!("CARGO_MANIFEST_DIR"); // .../app/src-tauri
        let cli = format!("{manifest}/../../src/cli.ts");
        ("bun".to_string(), vec![cli])
    } else {
        // Tauri places externalBin next to the app executable (Contents/MacOS/vn).
        let sidecar = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(plat::VN)))
            .and_then(|p| p.to_str().map(String::from))
            .unwrap_or_else(|| plat::VN.to_string());
        (sidecar, vec![])
    }
}

// ── Persistent engine: one long-lived `vn serve` the GUI talks to over stdio ──
//
// Instead of spawning `vn` per call (Bun cold start + Windows AV scan + console
// flash every time), we keep ONE `vn serve` process. Requests are correlated by
// id; the reader thread resolves responses and forwards engine events
// (login-event) to the webview.

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

struct Engine {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    child: Mutex<Child>,
}

#[derive(Default)]
struct EngineState(Mutex<Option<Arc<Engine>>>);

fn start_engine(app: &AppHandle) -> Result<Arc<Engine>, String> {
    let (program, mut args) = vn_command();
    args.push("serve".to_string());
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    apply_engine_env(&mut cmd, app);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW (belt-and-suspenders)
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn `{program} serve`: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin handle")?;
    let stdout = child.stdout.take().ok_or("no stdout handle")?;

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = pending.clone();
    let app_reader = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            let v: Value = match serde_json::from_str(t) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match v.get("type").and_then(|x| x.as_str()) {
                Some("res") => {
                    if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
                        if let Some(tx) = pending_reader.lock().unwrap().remove(&id) {
                            let r = if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
                                Err(err.to_string())
                            } else {
                                Ok(v.get("result").cloned().unwrap_or(Value::Null))
                            };
                            let _ = tx.send(r);
                        }
                    }
                }
                Some("event") => {
                    let event = v
                        .get("event")
                        .and_then(|x| x.as_str())
                        .unwrap_or("engine-event")
                        .to_string();
                    let payload = v.get("payload").cloned().unwrap_or(Value::Null);
                    let _ = app_reader.emit(&event, payload);
                }
                _ => {}
            }
        }
        // stdout closed (serve exited): fail any in-flight requests so callers unblock.
        for (_, tx) in pending_reader.lock().unwrap().drain() {
            let _ = tx.send(Err("engine process exited".to_string()));
        }
    });

    Ok(Arc::new(Engine {
        stdin: Mutex::new(stdin),
        pending,
        next_id: AtomicU64::new(1),
        child: Mutex::new(child),
    }))
}

/// Get the running engine, (re)spawning it if absent or dead.
fn engine(app: &AppHandle, state: &EngineState) -> Result<Arc<Engine>, String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(e) = guard.as_ref() {
        let alive = e
            .child
            .lock()
            .unwrap()
            .try_wait()
            .map(|s| s.is_none())
            .unwrap_or(false);
        if alive {
            return Ok(e.clone());
        }
    }
    let e = start_engine(app)?;
    *guard = Some(e.clone());
    Ok(e)
}

fn request(engine: &Engine, method: &str, params: Value) -> Result<Value, String> {
    let id = engine.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = channel();
    engine.pending.lock().unwrap().insert(id, tx);
    let msg = serde_json::json!({ "type": "req", "id": id, "method": method, "params": params });
    {
        let mut stdin = engine.stdin.lock().unwrap();
        writeln!(stdin, "{msg}").map_err(|e| format!("write to engine: {e}"))?;
        stdin.flush().map_err(|e| e.to_string())?;
    }
    rx.recv().map_err(|_| "engine closed".to_string())?
}

/// Read current file-based config (env map + identity) for the wizard prefill.
#[tauri::command]
fn config_get(app: AppHandle, state: State<'_, EngineState>) -> Result<Value, String> {
    let e = engine(&app, &state)?;
    request(&e, "config.get", Value::Null)
}

/// Persist config from the wizard. `payload` is `{ env: {..}, self: {name, aliases} }`.
#[tauri::command]
fn config_set(app: AppHandle, state: State<'_, EngineState>, payload: Value) -> Result<(), String> {
    let e = engine(&app, &state)?;
    request(&e, "config.set", payload).map(|_| ())
}

/// Structured health/config snapshot for the status dashboard.
#[tauri::command]
fn doctor_status(app: AppHandle, state: State<'_, EngineState>) -> Result<Value, String> {
    let e = engine(&app, &state)?;
    request(&e, "doctor", Value::Null)
}

/// Processing status of recent recordings: live job + done + failed.
#[tauri::command]
fn recent_jobs(app: AppHandle, state: State<'_, EngineState>) -> Result<Value, String> {
    let e = engine(&app, &state)?;
    request(&e, "jobs", serde_json::json!({ "limit": 40 }))
}

/// Ensure the autonomous background scheduler (mac LaunchAgent / Windows Task
/// Scheduler) is installed and points at THIS app's bundled engine. The
/// staleness check + (re)install now live in `vn` (ensureScheduler); this is a
/// thin forward. `force` reinstalls even if already current.
#[tauri::command]
fn ensure_agent(app: AppHandle, state: State<'_, EngineState>, force: bool) -> Result<String, String> {
    if cfg!(debug_assertions) {
        return Ok("dev: scheduler not managed".to_string());
    }
    let e = engine(&app, &state)?;
    request(&e, "ensure_agent", serde_json::json!({ "force": force })).map(|_| "ok".to_string())
}

/// Kick off the ChatGPT (Codex OAuth) login. Fire-and-forget: auth_url / success
/// / error / closed stream back to the webview as `login-event` via the engine
/// reader thread, so the UI thread never blocks on the whole OAuth round-trip.
#[tauri::command]
fn login_chatgpt(app: AppHandle, state: State<'_, EngineState>) -> Result<(), String> {
    let e = engine(&app, &state)?;
    std::thread::spawn(move || {
        let _ = request(&e, "login", Value::Null);
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(EngineState::default())
        .invoke_handler(tauri::generate_handler![
            login_chatgpt,
            config_get,
            config_set,
            doctor_status,
            recent_jobs,
            ensure_agent
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

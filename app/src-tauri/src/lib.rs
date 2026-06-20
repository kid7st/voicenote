use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use tauri::{AppHandle, Emitter, Manager};

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

/// Run a non-streaming `vn` subcommand, optionally feeding JSON on stdin, and
/// return captured stdout. Used for the request/response config commands.
fn run_vn_capture(app: &AppHandle, extra: &[&str], stdin_data: Option<&str>) -> Result<String, String> {
    let (program, mut args) = vn_command();
    for a in extra {
        args.push((*a).to_string());
    }
    let mut cmd = Command::new(&program);
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if stdin_data.is_some() { Stdio::piped() } else { Stdio::null() });
    apply_engine_env(&mut cmd, app);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn `{program}`: {e}"))?;
    if let Some(data) = stdin_data {
        child
            .stdin
            .take()
            .ok_or("no stdin handle")?
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "vn {} failed ({}): {}",
            extra.join(" "),
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Read current file-based config (env map + identity) for the wizard prefill.
#[tauri::command]
fn config_get(app: AppHandle) -> Result<serde_json::Value, String> {
    let out = run_vn_capture(&app, &["config", "get"], None)?;
    serde_json::from_str(&out).map_err(|e| format!("parse `vn config get`: {e}"))
}

/// Persist config from the wizard. `payload` is `{ env: {..}, self: {name, aliases} }`.
#[tauri::command]
fn config_set(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    let data = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    run_vn_capture(&app, &["config", "set"], Some(&data))?;
    Ok(())
}

/// Structured health/config snapshot for the status dashboard. Note: this runs
/// `pi --version` (and an ffprobe check), so it can take a couple seconds.
#[tauri::command]
fn doctor_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let out = run_vn_capture(&app, &["doctor", "--json"], None)?;
    serde_json::from_str(&out).map_err(|e| format!("parse `vn doctor --json`: {e}"))
}

/// Processing status of recent recordings: live job + done + failed.
#[tauri::command]
fn recent_jobs(app: AppHandle) -> Result<serde_json::Value, String> {
    let out = run_vn_capture(&app, &["jobs", "--json", "--limit", "40"], None)?;
    serde_json::from_str(&out).map_err(|e| format!("parse `vn jobs --json`: {e}"))
}

/// Ensure the autonomous background LaunchAgent is installed and points at THIS
/// app's bundled engine. The agent runs `vn run` every 60s independently of the
/// GUI, so the pipeline keeps working with the app closed. Idempotent: skips the
/// (disruptive) reload unless `force` or the plist targets a stale app location.
#[tauri::command]
fn ensure_agent(app: AppHandle, force: bool) -> Result<String, String> {
    if cfg!(debug_assertions) {
        return Ok("dev: launch agent not managed".to_string());
    }
    // Windows: no plist to diff. `vn install-launch-agent` is idempotent
    // (schtasks /create /f) and also persists the bundled-engine paths into
    // config.json so the env-less background task can find pi/ffprobe. Cheap to
    // re-run each launch, and it self-heals if the app was moved.
    #[cfg(windows)]
    {
        let _ = force;
        run_vn_capture(&app, &["install-launch-agent"], None)?;
        Ok("installed".to_string())
    }
    // macOS: skip the disruptive launchctl reload unless forced or the plist
    // points at a stale app location.
    #[cfg(not(windows))]
    {
        let exe = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(plat::VN)))
            .and_then(|p| p.to_str().map(String::from))
            .unwrap_or_default();
        let plist = app
            .path()
            .home_dir()
            .map_err(|e| e.to_string())?
            .join("Library/LaunchAgents/com.kid7st.voicenote.plist");
        if !force {
            if let Ok(content) = std::fs::read_to_string(&plist) {
                if !exe.is_empty() && content.contains(&exe) {
                    return Ok("up-to-date".to_string());
                }
            }
        }
        run_vn_capture(&app, &["install-launch-agent", "--load"], None)?;
        Ok("installed".to_string())
    }
}

/// Start `vn login --json` and stream its JSON events to the frontend.
///
/// Each stdout line is one event object: `{event:"auth_url"|"device_code"|
/// "success"|"error", ...}`. We forward parsed JSON as `login-event` and any
/// non-JSON / stderr noise as `login-log`. The browser is opened by `vn`
/// itself (macOS `open`); the frontend also shows the URL as a fallback.
#[tauri::command]
fn login_chatgpt(app: AppHandle) -> Result<(), String> {
    let (program, mut args) = vn_command();
    args.push("login".to_string());
    args.push("--json".to_string());

    let mut cmd = Command::new(&program);
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::inherit());
    apply_engine_env(&mut cmd, &app);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn `{program}`: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout handle")?;

    // stdout -> login-event (the JSON protocol). Real failures arrive as
    // {event:"error"} on stdout; stderr is left inherited for diagnostics.

    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(val) => {
                    let _ = app.emit("login-event", val);
                }
                Err(_) => {
                    let _ = app.emit("login-log", trimmed.to_string());
                }
            }
        }
        let code = child.wait().ok().and_then(|s| s.code());
        let _ = app.emit("login-event", serde_json::json!({ "event": "closed", "code": code }));
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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

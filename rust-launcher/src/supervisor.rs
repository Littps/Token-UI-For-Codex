use std::fs;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;
use windows::Win32::Foundation::HANDLE;

use crate::config::{LauncherOptions, RuntimePaths};
use crate::node::{CREATE_NO_WINDOW, NodeCandidate, resolve_node};
use crate::state::{
    ExclusiveFileLock, MonitorHeartbeat, WatchdogState, append_log, heartbeat_age, now_iso,
    now_millis, read_json, write_json_atomic,
};
use crate::win::{JobHandle, NamedMutex, process_image_path, process_is_alive};

const MUTEX_NAME: &str = r"Local\TokensUIForCodex.Watchdog.v1";
struct ManagedChild {
    child: Child,
    _job: JobHandle,
    started_at: Instant,
}

impl ManagedChild {
    fn spawn(paths: &RuntimePaths, node: &NodeCandidate) -> Result<Self> {
        anyhow::ensure!(
            paths.script_path.is_file(),
            "monitor script not found: {}",
            paths.script_path.display()
        );
        let mut command = Command::new(&node.path);
        command
            .arg(&paths.script_path)
            .arg("--watch")
            .arg("--cdp")
            .arg("--port")
            .arg("auto")
            .arg("--state-dir")
            .arg(&paths.state_dir)
            .arg("--lock-file")
            .arg(&paths.lock_file)
            .arg("--guard-lock-file")
            .arg(&paths.guard_lock_file)
            .arg("--heartbeat-file")
            .arg(&paths.heartbeat_file)
            .arg("--log-dir")
            .arg(&paths.log_dir)
            .arg("--history-dir")
            .arg(&paths.history_dir)
            .env("CODEX_HOME", &paths.codex_home)
            .env("TUI_STATE_DIR", &paths.state_dir)
            .env("TUI_LOCK_FILE", &paths.lock_file)
            .env("TUI_GUARD_LOCK_FILE", &paths.guard_lock_file)
            .env("TUI_HEARTBEAT_FILE", &paths.heartbeat_file)
            .env("TUI_LOG_DIR", &paths.log_dir)
            .env("TUI_HISTORY_DIR", &paths.history_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let child = command
            .spawn()
            .with_context(|| format!("cannot start Node monitor: {}", node.path.display()))?;
        let job = JobHandle::create()?;
        let process_handle = HANDLE(child.as_raw_handle() as _);
        job.assign(process_handle)?;
        Ok(Self {
            child,
            _job: job,
            started_at: Instant::now(),
        })
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn running(&mut self) -> Result<bool> {
        Ok(self.child.try_wait()?.is_none())
    }

    fn stop(&mut self) -> Result<()> {
        if self.child.try_wait()?.is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        Ok(())
    }
}

pub fn run_supervisor(options: LauncherOptions) -> Result<()> {
    let paths = options.runtime_paths()?;
    paths.prepare()?;
    let _mutex = NamedMutex::acquire(MUTEX_NAME)?
        .context("another Rust watchdog is already running for this Windows session")?;

    reject_existing_monitor(&paths)?;
    let node = resolve_node(options.node_override.as_deref())?;
    append_log(
        &paths.log_dir,
        &format!(
            "Rust supervisor starting: pid={}, node={} ({})",
            std::process::id(),
            node.path.display(),
            node.version
        ),
    )?;

    let launcher_path = std::env::current_exe()?;
    let _watchdog_lock = ExclusiveFileLock::acquire(
        &paths.watchdog_lock_file,
        &serde_json::json!({
            "pid": std::process::id(),
            "startedAt": now_iso(),
            "mode": "rust"
        }),
    )?;
    let mut state = WatchdogState::new(std::process::id(), &launcher_path);
    write_json_atomic(&paths.watchdog_state_file, &state)?;

    let mut child: Option<ManagedChild> = None;
    let mut first_stale_at = 0_u64;
    let mut next_restart_at = 0_u64;
    let mut consecutive_failures = 0_u32;

    loop {
        let now = now_millis();
        state.last_check_at = Some(now_iso());
        state.watchdog_pid = std::process::id();
        state.consecutive_failures = consecutive_failures;
        state.next_restart_at = next_restart_at;

        if child
            .as_mut()
            .is_some_and(|managed| !managed.running().unwrap_or(false))
            && let Some(mut exited) = child.take()
        {
            let code = exited.child.wait().ok().and_then(|status| status.code());
            consecutive_failures = consecutive_failures.saturating_add(1);
            let backoff_ms = restart_backoff_ms(&options, consecutive_failures);
            state.pid = None;
            state.phase = "recovering".to_string();
            state.last_action = "child-exited".to_string();
            state.last_error = Some(format!("monitor exited with code {:?}", code));
            state.consecutive_failures = consecutive_failures;
            next_restart_at = now.saturating_add(backoff_ms);
            state.next_restart_at = next_restart_at;
            append_log(
                &paths.log_dir,
                &format!(
                    "Node monitor exited: pid={} code={:?} backoff={}ms",
                    exited.pid(),
                    code,
                    backoff_ms
                ),
            )?;
        }

        if child.is_none() && now >= next_restart_at {
            match ManagedChild::spawn(&paths, &node) {
                Ok(managed) => {
                    state.pid = Some(managed.pid());
                    state.monitor_started_at = Some(now_iso());
                    state.phase = "starting".to_string();
                    state.last_action = "started".to_string();
                    state.last_error = None;
                    state.last_restart_at = now;
                    next_restart_at = 0;
                    first_stale_at = 0;
                    append_log(
                        &paths.log_dir,
                        &format!("Started Node monitor: pid={}", managed.pid()),
                    )?;
                    child = Some(managed);
                }
                Err(error) => {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    let backoff_ms = restart_backoff_ms(&options, consecutive_failures);
                    next_restart_at = now.saturating_add(backoff_ms);
                    state.phase = "failed".to_string();
                    state.last_action = "start-failed".to_string();
                    state.last_error = Some(error.to_string());
                    state.consecutive_failures = consecutive_failures;
                    state.next_restart_at = next_restart_at;
                    append_log(
                        &paths.log_dir,
                        &format!("Failed to start Node monitor: {error:#}"),
                    )?;
                }
            }
        }

        if let Some(managed) = child.as_mut() {
            let age_ms = managed.started_at.elapsed().as_millis() as u64;
            let heartbeat: Option<MonitorHeartbeat> = read_json(&paths.heartbeat_file);
            let heartbeat_matches = heartbeat
                .as_ref()
                .and_then(|value| value.pid)
                .is_some_and(|pid| pid == managed.pid());
            let hb_age = heartbeat_age(&paths.heartbeat_file);
            state.heartbeat_seq = heartbeat
                .as_ref()
                .and_then(|value| value.heartbeat_seq)
                .unwrap_or(0);
            state.monitor_started_at = heartbeat
                .as_ref()
                .and_then(|value| value.started_at.clone())
                .or_else(|| state.monitor_started_at.clone());

            if heartbeat_matches
                && hb_age.is_some_and(|age| age.as_millis() <= options.soft_stale_ms as u128)
            {
                first_stale_at = 0;
                consecutive_failures = 0;
                state.phase = "healthy".to_string();
                state.last_action = "none".to_string();
                state.last_error = None;
            } else if age_ms < options.startup_grace_ms {
                state.phase = "starting".to_string();
                state.last_action = "wait-startup".to_string();
            } else {
                if first_stale_at == 0 {
                    first_stale_at = now;
                    state.phase = "stale-candidate".to_string();
                    state.last_action = "observe-stale".to_string();
                } else if now.saturating_sub(first_stale_at) >= options.soft_stale_ms
                    && hb_age.is_none_or(|age| age.as_millis() >= options.hard_stale_ms as u128)
                {
                    let pid = managed.pid();
                    append_log(
                        &paths.log_dir,
                        &format!("Restarting stale Node monitor: pid={pid}"),
                    )?;
                    let _ = managed.stop();
                    child = None;
                    state.pid = None;
                    state.phase = "recovering".to_string();
                    state.last_action = "restart-stale".to_string();
                    first_stale_at = 0;
                    next_restart_at = now;
                } else {
                    state.phase = "stale-candidate".to_string();
                    state.last_action = "confirm-stale".to_string();
                }
            }
        }

        state.first_stale_at = first_stale_at;
        state.next_restart_at = next_restart_at;
        write_json_atomic(&paths.watchdog_state_file, &state)?;
        thread::sleep(Duration::from_millis(options.poll_ms.max(100)));
    }
}

fn reject_existing_monitor(paths: &RuntimePaths) -> Result<()> {
    if let Some(heartbeat) = read_json::<MonitorHeartbeat>(&paths.heartbeat_file)
        && let Some(pid) = heartbeat.pid
        && process_is_alive(pid)
    {
        let image = process_image_path(pid)
            .map(|value| value.display().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        anyhow::bail!(
            "existing monitor PID {pid} is still running ({image}); stop the PowerShell watchdog first"
        );
    }
    if let Some(lock) = read_json::<serde_json::Value>(&paths.watchdog_lock_file) {
        if let Some(pid) = lock.get("pid").and_then(|value| value.as_u64())
            && process_is_alive(pid as u32)
        {
            anyhow::bail!("existing watchdog PID {pid} is still running");
        }
        fs::remove_file(&paths.watchdog_lock_file).ok();
    }
    Ok(())
}

fn restart_backoff_ms(options: &LauncherOptions, failures: u32) -> u64 {
    let index = (failures.saturating_sub(1) as usize).min(options.backoff_seconds.len() - 1);
    options.backoff_seconds[index].saturating_mul(1_000)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub paths: RuntimePaths,
    pub node: Option<NodeCandidate>,
    pub watchdog_state: Option<serde_json::Value>,
    pub heartbeat: Option<serde_json::Value>,
    pub heartbeat_age_ms: Option<u128>,
    pub launcher_alive: Option<bool>,
    pub monitor_alive: Option<bool>,
    pub errors: Vec<String>,
}

pub fn diagnose(options: &LauncherOptions) -> Result<DoctorReport> {
    let mut errors = Vec::new();
    let paths = options.runtime_paths()?;
    let node = match resolve_node(options.node_override.as_deref()) {
        Ok(node) => Some(node),
        Err(error) => {
            errors.push(error.to_string());
            None
        }
    };
    if !paths.script_path.is_file() {
        errors.push(format!(
            "monitor script missing: {}",
            paths.script_path.display()
        ));
    }
    let watchdog_state = crate::state::read_json_any(&paths.watchdog_state_file);
    let heartbeat = crate::state::read_json_any(&paths.heartbeat_file);
    let launcher_pid = watchdog_state
        .as_ref()
        .and_then(|value| value.get("watchdogPid"))
        .and_then(|value| value.as_u64())
        .map(|pid| pid as u32);
    let monitor_pid = heartbeat
        .as_ref()
        .and_then(|value| value.get("pid"))
        .and_then(|value| value.as_u64())
        .map(|pid| pid as u32);
    Ok(DoctorReport {
        paths: paths.clone(),
        node,
        watchdog_state,
        heartbeat,
        heartbeat_age_ms: heartbeat_age(&paths.heartbeat_file).map(|value| value.as_millis()),
        launcher_alive: launcher_pid.map(process_is_alive),
        monitor_alive: monitor_pid.map(process_is_alive),
        errors,
    })
}

pub fn stop_supervisor(options: &LauncherOptions) -> Result<()> {
    let paths = options.runtime_paths()?;
    let state: Option<serde_json::Value> = read_json(&paths.watchdog_state_file);
    let pid = state
        .as_ref()
        .and_then(|value| value.get("watchdogPid"))
        .and_then(|value| value.as_u64())
        .map(|value| value as u32)
        .context("watchdog-state.json does not contain watchdogPid")?;
    let image = process_image_path(pid).context("watchdog process is not running")?;
    anyhow::ensure!(
        image
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("tokens-ui-launcher.exe")),
        "refusing to stop unexpected process {}",
        image.display()
    );
    crate::win::terminate_process(pid)
}

#[cfg(test)]
mod tests {
    use super::restart_backoff_ms;
    use crate::config::LauncherOptions;

    #[test]
    fn backoff_uses_each_value_then_caps_at_the_last() {
        let mut options = LauncherOptions::from_args(&[
            "--plugin-root".to_string(),
            ".".to_string(),
            "--backoff-seconds".to_string(),
            "1,2,5".to_string(),
        ])
        .expect("options");
        options.backoff_seconds = vec![1, 2, 5];
        assert_eq!(restart_backoff_ms(&options, 1), 1_000);
        assert_eq!(restart_backoff_ms(&options, 2), 2_000);
        assert_eq!(restart_backoff_ms(&options, 3), 5_000);
        assert_eq!(restart_backoff_ms(&options, 99), 5_000);
    }
}

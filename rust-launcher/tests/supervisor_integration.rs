#![cfg(windows)]

use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tempfile::TempDir;
use tokens_ui_launcher::node::CREATE_NO_WINDOW;
use tokens_ui_launcher::win::{process_is_alive, terminate_process};

const MOCK_MONITOR: &str = include_str!("fixtures/mock-monitor.mjs");

struct ChildGuard {
    child: Option<Child>,
}

impl ChildGuard {
    fn spawn(mut command: Command) -> Self {
        let child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn process");
        Self { child: Some(child) }
    }

    fn pid(&self) -> u32 {
        self.child.as_ref().expect("child present").id()
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> Option<std::process::ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            let child = self.child.as_mut().expect("child present");
            if let Some(status) = child.try_wait().expect("try_wait") {
                return Some(status);
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take()
            && child.try_wait().ok().flatten().is_none()
        {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct Fixture {
    _temp: TempDir,
    plugin_root: PathBuf,
    codex_home: PathBuf,
    node: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("tempdir");
        let plugin_root = temp.path().join("plugin");
        let codex_home = temp.path().join("codex-home");
        fs::create_dir_all(&plugin_root).expect("plugin dir");
        fs::create_dir_all(&codex_home).expect("codex home");
        fs::write(plugin_root.join("token-stats.mjs"), MOCK_MONITOR).expect("mock monitor");
        fs::write(
            plugin_root.join("runtime-paths.json"),
            serde_json::to_vec_pretty(&json!({ "codexHome": codex_home })).expect("json"),
        )
        .expect("runtime paths");
        Self {
            _temp: temp,
            plugin_root,
            codex_home,
            node: find_node(),
        }
    }

    fn state_dir(&self) -> PathBuf {
        self.codex_home.join("tokens-ui-for-codex").join("state")
    }

    fn state_file(&self) -> PathBuf {
        self.state_dir().join("watchdog-state.json")
    }

    fn launcher_command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_tokens-ui-launcher"));
        command
            .arg("--supervise")
            .arg("--plugin-root")
            .arg(&self.plugin_root)
            .arg("--node")
            .arg(&self.node)
            .arg("--poll-ms")
            .arg("150")
            .arg("--startup-grace-ms")
            .arg("1000")
            .arg("--soft-stale-ms")
            .arg("1500")
            .arg("--hard-stale-ms")
            .arg("2500")
            .arg("--backoff-seconds")
            .arg("1,2,5")
            .env("TUI_CODEX_HOME", &self.codex_home);
        command
    }

    fn doctor(&self, action: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_tokens-ui-doctor"))
            .arg(action)
            .arg("--plugin-root")
            .arg(&self.plugin_root)
            .arg("--node")
            .arg(&self.node)
            .env("TUI_CODEX_HOME", &self.codex_home)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .expect("run doctor")
    }
}

#[test]
fn supervisor_lifecycle_is_single_instance_restartable_and_job_contained() {
    let fixture = Fixture::new();
    let supervisor = ChildGuard::spawn(fixture.launcher_command());

    let first_state = wait_for_json(&fixture.state_file(), Duration::from_secs(15), |state| {
        state.get("phase").and_then(Value::as_str) == Some("healthy")
    });
    assert_eq!(
        first_state.get("watchdogPid").and_then(Value::as_u64),
        Some(supervisor.pid() as u64)
    );
    let first_monitor_pid = first_state
        .get("pid")
        .and_then(Value::as_u64)
        .expect("monitor pid") as u32;
    assert!(process_is_alive(first_monitor_pid));

    let mut second = ChildGuard::spawn(fixture.launcher_command());
    let second_status = second
        .wait_for_exit(Duration::from_secs(5))
        .expect("second supervisor must exit");
    assert!(
        !second_status.success(),
        "second supervisor must be rejected"
    );

    terminate_process(first_monitor_pid).expect("terminate first monitor");
    wait_for_json(&fixture.state_file(), Duration::from_secs(8), |state| {
        state.get("lastAction").and_then(Value::as_str) == Some("child-exited")
    });
    let recovered_state = wait_for_json(&fixture.state_file(), Duration::from_secs(12), |state| {
        let pid = state.get("pid").and_then(Value::as_u64);
        state.get("phase").and_then(Value::as_str) == Some("healthy")
            && pid.is_some_and(|pid| pid != first_monitor_pid as u64)
    });
    let recovered_monitor_pid = recovered_state
        .get("pid")
        .and_then(Value::as_u64)
        .expect("recovered monitor pid") as u32;
    assert!(!process_is_alive(first_monitor_pid));
    assert!(process_is_alive(recovered_monitor_pid));

    let diagnosis = fixture.doctor("--diagnose");
    assert!(
        diagnosis.status.success(),
        "doctor stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&diagnosis.stdout),
        String::from_utf8_lossy(&diagnosis.stderr)
    );
    let report: Value = serde_json::from_slice(&diagnosis.stdout).expect("doctor report");
    assert_eq!(report.get("launcherAlive"), Some(&Value::Bool(true)));
    assert_eq!(report.get("monitorAlive"), Some(&Value::Bool(true)));

    let stop = fixture.doctor("--stop");
    assert!(
        stop.status.success(),
        "doctor stop stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&stop.stdout),
        String::from_utf8_lossy(&stop.stderr)
    );
    wait_until(Duration::from_secs(10), || {
        !process_is_alive(supervisor.pid()) && !process_is_alive(recovered_monitor_pid)
    });
}

fn find_node() -> PathBuf {
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        let candidate = PathBuf::from(program_files).join("nodejs").join("node.exe");
        if candidate.is_file() {
            return candidate;
        }
    }
    let output = Command::new("where.exe")
        .arg("node.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .expect("where node.exe");
    assert!(output.status.success(), "node.exe must be installed");
    let first = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .expect("node path")
        .trim()
        .to_string();
    PathBuf::from(first)
}

fn wait_for_json(path: &Path, timeout: Duration, predicate: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(text) = fs::read_to_string(path)
            && let Ok(value) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}'))
            && predicate(&value)
        {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(50));
    }
}

fn wait_until(timeout: Duration, predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + timeout;
    while !predicate() {
        assert!(Instant::now() < deadline, "condition timed out");
        thread::sleep(Duration::from_millis(50));
    }
}

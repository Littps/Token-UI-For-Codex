use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogState {
    pub schema_version: u32,
    pub watchdog_mode: String,
    pub watchdog_pid: u32,
    pub pid: Option<u32>,
    pub last_check_at: Option<String>,
    pub heartbeat_seq: u64,
    pub first_stale_at: u64,
    pub consecutive_failures: u32,
    pub next_restart_at: u64,
    pub last_restart_at: u64,
    pub identity_restart_pid: u32,
    pub identity_restart_started_at: String,
    pub last_action: String,
    pub last_error: Option<String>,
    pub phase: String,
    pub monitor_started_at: Option<String>,
    pub launcher_path: String,
}

impl WatchdogState {
    pub fn new(pid: u32, launcher_path: &Path) -> Self {
        Self {
            schema_version: 1,
            watchdog_mode: "resident".to_string(),
            watchdog_pid: pid,
            pid: None,
            last_check_at: None,
            heartbeat_seq: 0,
            first_stale_at: 0,
            consecutive_failures: 0,
            next_restart_at: 0,
            last_restart_at: 0,
            identity_restart_pid: 0,
            identity_restart_started_at: String::new(),
            last_action: "starting".to_string(),
            last_error: None,
            phase: "starting".to_string(),
            monitor_started_at: None,
            launcher_path: launcher_path.display().to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorHeartbeat {
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub heartbeat_at: Option<String>,
    pub heartbeat_seq: Option<u64>,
    pub script_path: Option<String>,
    pub state_dir: Option<String>,
}

pub fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let mut text = serde_json::to_vec(value).context("serialize JSON")?;
    text.push(b'\r');
    text.push(b'\n');
    fs::write(&temp, text).with_context(|| format!("write {}", temp.display()))?;
    if path.exists() {
        fs::remove_file(path).with_context(|| format!("remove old {}", path.display()))?;
    }
    fs::rename(&temp, path)
        .or_else(|_| {
            fs::copy(&temp, path)?;
            fs::remove_file(&temp)
        })
        .with_context(|| format!("replace {}", path.display()))
}

pub struct ExclusiveFileLock {
    file: Option<File>,
    path: PathBuf,
}

impl ExclusiveFileLock {
    pub fn acquire<T: Serialize>(path: &Path, value: &T) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(true)
            .share_mode(0)
            .open(path)
            .with_context(|| format!("open exclusive lock {}", path.display()))?;
        serde_json::to_writer(&mut file, value).context("serialize exclusive lock")?;
        file.write_all(b"\r\n")?;
        file.flush()?;
        Ok(Self {
            file: Some(file),
            path: path.to_path_buf(),
        })
    }
}

impl Drop for ExclusiveFileLock {
    fn drop(&mut self) {
        self.file.take();
        fs::remove_file(&self.path).ok();
    }
}

pub fn heartbeat_age(path: &Path) -> Option<Duration> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    SystemTime::now().duration_since(modified).ok()
}

pub fn append_log(log_dir: &Path, message: &str) -> Result<()> {
    fs::create_dir_all(log_dir)?;
    let day = OffsetDateTime::now_utc().date().to_string();
    let path = log_dir.join(format!("launcher-{day}.log"));
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let stamp = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| now_iso());
    writeln!(file, "[{stamp}] {message}")?;
    Ok(())
}

pub fn read_json_any(path: &Path) -> Option<serde_json::Value> {
    read_json(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn state_round_trip_is_atomic_and_valid_json() {
        let dir = tempdir().expect("temp");
        let path = dir.path().join("watchdog-state.json");
        let mut state = WatchdogState::new(42, Path::new(r"C:\launcher.exe"));
        state.phase = "healthy".to_string();
        write_json_atomic(&path, &state).expect("write");
        let loaded: WatchdogState = read_json(&path).expect("read");
        assert_eq!(loaded.watchdog_pid, 42);
        assert_eq!(loaded.phase, "healthy");
    }

    #[test]
    fn exclusive_watchdog_lock_rejects_a_second_owner() {
        let dir = tempdir().expect("temp");
        let path = dir.path().join("watchdog.lock");
        let first = ExclusiveFileLock::acquire(&path, &serde_json::json!({ "pid": 1 }))
            .expect("first lock");
        assert!(ExclusiveFileLock::acquire(&path, &serde_json::json!({ "pid": 2 })).is_err());
        drop(first);
        ExclusiveFileLock::acquire(&path, &serde_json::json!({ "pid": 3 })).expect("reacquire");
    }
}

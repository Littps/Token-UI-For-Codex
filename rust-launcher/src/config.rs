use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct LauncherOptions {
    pub plugin_root: PathBuf,
    pub node_override: Option<PathBuf>,
    pub script_override: Option<PathBuf>,
    pub poll_ms: u64,
    pub startup_grace_ms: u64,
    pub soft_stale_ms: u64,
    pub hard_stale_ms: u64,
    pub backoff_seconds: Vec<u64>,
}

impl LauncherOptions {
    pub fn from_args(args: &[String]) -> Result<Self> {
        let mut options = Self {
            plugin_root: std::env::current_exe()?
                .parent()
                .context("launcher executable has no parent directory")?
                .to_path_buf(),
            node_override: None,
            script_override: None,
            poll_ms: 15_000,
            startup_grace_ms: 120_000,
            soft_stale_ms: 45_000,
            hard_stale_ms: 120_000,
            backoff_seconds: vec![60, 120, 300, 600, 900],
        };

        let mut index = 0;
        while index < args.len() {
            match args[index].as_str() {
                "--supervise" => {}
                "--plugin-root" => options.plugin_root = PathBuf::from(next_arg(args, &mut index)?),
                "--node" => {
                    options.node_override = Some(PathBuf::from(next_arg(args, &mut index)?))
                }
                "--script" => {
                    options.script_override = Some(PathBuf::from(next_arg(args, &mut index)?))
                }
                "--poll-ms" => {
                    options.poll_ms = parse_u64(next_arg(args, &mut index)?, "--poll-ms")?
                }
                "--startup-grace-ms" => {
                    options.startup_grace_ms =
                        parse_u64(next_arg(args, &mut index)?, "--startup-grace-ms")?
                }
                "--soft-stale-ms" => {
                    options.soft_stale_ms =
                        parse_u64(next_arg(args, &mut index)?, "--soft-stale-ms")?
                }
                "--hard-stale-ms" => {
                    options.hard_stale_ms =
                        parse_u64(next_arg(args, &mut index)?, "--hard-stale-ms")?
                }
                "--backoff-seconds" => {
                    options.backoff_seconds =
                        parse_seconds_list(&next_arg(args, &mut index)?, "--backoff-seconds")?
                }
                "--version" | "-V" => {
                    println!("{}", env!("CARGO_PKG_VERSION"));
                    std::process::exit(0);
                }
                unknown => anyhow::bail!("unknown launcher argument: {unknown}"),
            }
            index += 1;
        }
        options.plugin_root = fs::canonicalize(&options.plugin_root)
            .with_context(|| format!("invalid plugin root: {}", options.plugin_root.display()))?;
        options.validate()?;
        Ok(options)
    }

    pub fn runtime_paths(&self) -> Result<RuntimePaths> {
        RuntimePaths::load(&self.plugin_root, self.script_override.clone())
    }

    fn validate(&self) -> Result<()> {
        anyhow::ensure!(self.poll_ms >= 100, "--poll-ms must be at least 100");
        anyhow::ensure!(
            self.hard_stale_ms >= self.soft_stale_ms,
            "--hard-stale-ms must be greater than or equal to --soft-stale-ms"
        );
        anyhow::ensure!(
            !self.backoff_seconds.is_empty(),
            "--backoff-seconds must contain at least one value"
        );
        anyhow::ensure!(
            self.backoff_seconds.iter().all(|value| *value > 0),
            "--backoff-seconds values must be greater than zero"
        );
        Ok(())
    }
}

fn next_arg(args: &[String], index: &mut usize) -> Result<String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .with_context(|| format!("missing value for {}", args[*index - 1]))
}

fn parse_u64(value: String, flag: &str) -> Result<u64> {
    value
        .parse::<u64>()
        .with_context(|| format!("{flag} expects a non-negative integer"))
}

fn parse_seconds_list(value: &str, flag: &str) -> Result<Vec<u64>> {
    value
        .split(',')
        .map(|part| {
            part.trim()
                .parse::<u64>()
                .with_context(|| format!("{flag} expects comma-separated seconds"))
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePathsFile {
    codex_home: Option<String>,
    state_dir: Option<String>,
    lock_file: Option<String>,
    guard_lock_file: Option<String>,
    heartbeat_file: Option<String>,
    log_dir: Option<String>,
    history_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePaths {
    pub plugin_root: PathBuf,
    pub codex_home: PathBuf,
    pub state_dir: PathBuf,
    pub lock_file: PathBuf,
    pub guard_lock_file: PathBuf,
    pub heartbeat_file: PathBuf,
    pub log_dir: PathBuf,
    pub history_dir: PathBuf,
    pub script_path: PathBuf,
    pub watchdog_lock_file: PathBuf,
    pub watchdog_state_file: PathBuf,
    pub launcher_log: PathBuf,
}

impl RuntimePaths {
    pub fn load(plugin_root: &Path, script_override: Option<PathBuf>) -> Result<Self> {
        let config_path = plugin_root.join("runtime-paths.json");
        let config = if config_path.is_file() {
            let text = fs::read_to_string(&config_path)
                .with_context(|| format!("cannot read {}", config_path.display()))?;
            serde_json::from_str::<RuntimePathsFile>(text.trim_start_matches('\u{feff}'))
                .with_context(|| format!("invalid JSON in {}", config_path.display()))?
        } else {
            RuntimePathsFile {
                codex_home: None,
                state_dir: None,
                lock_file: None,
                guard_lock_file: None,
                heartbeat_file: None,
                log_dir: None,
                history_dir: None,
            }
        };

        let home = home_dir()?;
        let codex_home = env::var_os("TUI_CODEX_HOME")
            .or_else(|| env::var_os("CODEX_HOME"))
            .map(PathBuf::from)
            .or_else(|| config.codex_home.as_ref().map(PathBuf::from))
            .unwrap_or_else(|| home.join(".codex"));
        let base = codex_home.join("tokens-ui-for-codex");
        let resolve = |value: Option<&String>, fallback: PathBuf| {
            value
                .map(PathBuf::from)
                .map(|path| {
                    if path.is_absolute() {
                        path
                    } else {
                        plugin_root.join(path)
                    }
                })
                .unwrap_or(fallback)
        };
        let state_dir = resolve(config.state_dir.as_ref(), base.join("state"));
        let lock_file = resolve(config.lock_file.as_ref(), base.join("monitor.lock"));
        let guard_lock_file = resolve(
            config.guard_lock_file.as_ref(),
            home.join(".tokens-ui-for-codex").join("monitor.guard.lock"),
        );
        let heartbeat_file = resolve(
            config.heartbeat_file.as_ref(),
            state_dir.join("monitor-heartbeat.json"),
        );
        let log_dir = resolve(config.log_dir.as_ref(), state_dir.join("logs"));
        let history_dir = resolve(config.history_dir.as_ref(), state_dir.join("history"));
        let script_path = script_override.unwrap_or_else(|| plugin_root.join("token-stats.mjs"));

        Ok(Self {
            plugin_root: plugin_root.to_path_buf(),
            codex_home,
            state_dir: state_dir.clone(),
            lock_file,
            guard_lock_file,
            heartbeat_file,
            log_dir: log_dir.clone(),
            history_dir,
            script_path,
            watchdog_lock_file: state_dir.join("watchdog.lock"),
            watchdog_state_file: state_dir.join("watchdog-state.json"),
            launcher_log: log_dir.join("launcher.log"),
        })
    }

    pub fn prepare(&self) -> Result<()> {
        fs::create_dir_all(&self.state_dir)?;
        fs::create_dir_all(&self.log_dir)?;
        fs::create_dir_all(&self.history_dir)?;
        if let Some(parent) = self.lock_file.parent() {
            fs::create_dir_all(parent)?;
        }
        if let Some(parent) = self.guard_lock_file.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }
}

fn home_dir() -> Result<PathBuf> {
    env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .context("USERPROFILE is not set")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_launcher_overrides() {
        let args = vec![
            "--supervise".to_string(),
            "--plugin-root".to_string(),
            ".".to_string(),
            "--poll-ms".to_string(),
            "250".to_string(),
            "--soft-stale-ms".to_string(),
            "800".to_string(),
            "--hard-stale-ms".to_string(),
            "900".to_string(),
            "--backoff-seconds".to_string(),
            "1,2,5".to_string(),
        ];
        let options = LauncherOptions::from_args(&args).expect("options");
        assert_eq!(options.poll_ms, 250);
        assert_eq!(options.soft_stale_ms, 800);
        assert_eq!(options.hard_stale_ms, 900);
        assert_eq!(options.backoff_seconds, vec![1, 2, 5]);
    }
}

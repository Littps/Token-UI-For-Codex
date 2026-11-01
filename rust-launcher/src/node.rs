use std::collections::HashSet;
use std::env;
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};
use serde::Serialize;

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeCandidate {
    pub path: PathBuf,
    pub version: String,
    pub version_key: (u64, u64, u64),
}

pub fn validate_node(path: &Path) -> Result<NodeCandidate> {
    anyhow::ensure!(
        path.is_file(),
        "Node executable not found: {}",
        path.display()
    );
    anyhow::ensure!(
        path.extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("exe")),
        "Node candidate must be an .exe: {}",
        path.display()
    );
    let output = Command::new(path)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .with_context(|| format!("cannot execute {}", path.display()))?;
    anyhow::ensure!(
        output.status.success(),
        "node --version failed for {}",
        path.display()
    );
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let version_key = parse_node_version(&version).with_context(|| {
        format!(
            "unexpected Node version output from {}: {version}",
            path.display()
        )
    })?;
    anyhow::ensure!(
        version_key.0 >= 22,
        "Node 22 or newer is required; {} reports {version}",
        path.display()
    );
    Ok(NodeCandidate {
        path: path.to_path_buf(),
        version,
        version_key,
    })
}

pub fn resolve_node(explicit: Option<&Path>) -> Result<NodeCandidate> {
    if let Some(path) = explicit {
        return validate_node(path);
    }

    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            candidates.push(directory.join("node.exe"));
        }
    }
    if let Some(program_files) = env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("nodejs").join("node.exe"));
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("nodejs")
                .join("node.exe"),
        );
    }
    if let Some(home) = env::var_os("USERPROFILE") {
        collect_node_files(
            &PathBuf::from(home).join(".cache").join("codex-runtimes"),
            0,
            &mut candidates,
        );
    }

    let mut seen = HashSet::new();
    let mut valid = Vec::new();
    for candidate in candidates {
        let normalized = candidate.to_string_lossy().to_ascii_lowercase();
        if !seen.insert(normalized) || !candidate.is_file() {
            continue;
        }
        if let Ok(item) = validate_node(&candidate) {
            valid.push(item);
        }
    }
    valid
        .into_iter()
        .max_by_key(|candidate| candidate.version_key)
        .context("Node.js 22+ was not found in PATH, Program Files, NVM or the Codex runtime")
}

fn collect_node_files(root: &Path, depth: usize, candidates: &mut Vec<PathBuf>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_node_files(&path, depth + 1, candidates);
        } else if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("node.exe"))
        {
            candidates.push(path);
        }
    }
}

pub fn parse_node_version(version: &str) -> Option<(u64, u64, u64)> {
    let value = version.trim().strip_prefix('v').unwrap_or(version.trim());
    let mut parts = value.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.split('-').next()?.parse().ok()?;
    Some((major, minor, patch))
}

#[cfg(test)]
mod tests {
    use super::parse_node_version;

    #[test]
    fn parses_stable_and_prerelease_versions() {
        assert_eq!(parse_node_version("v22.12.0"), Some((22, 12, 0)));
        assert_eq!(parse_node_version("v26.12.1-preview.1"), Some((26, 12, 1)));
        assert_eq!(parse_node_version("not-a-version"), None);
    }
}

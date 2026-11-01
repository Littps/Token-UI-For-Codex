import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_PATH_SCHEMA_VERSION = 1;
export const RUNTIME_DIR_NAME = "tokens-ui-for-codex";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionValue(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (argument === name && argv[index + 1] != null) return nonEmpty(String(argv[index + 1]));
    if (argument.startsWith(name + "=")) return nonEmpty(argument.slice(name.length + 1));
  }
  return null;
}

function absolutePath(value, baseDir) {
  const text = nonEmpty(value);
  return text ? path.resolve(baseDir, text) : null;
}

export function readRuntimePathConfig(file) {
  if (!file) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    if (payload.schemaVersion !== RUNTIME_PATH_SCHEMA_VERSION) return null;
    return payload;
  } catch {
    return null;
  }
}

export function resolveRuntimePaths({
  argv = process.argv.slice(2),
  env = process.env,
  homeDir = os.homedir(),
  scriptDir = path.dirname(fileURLToPath(import.meta.url)),
  configFile = null,
  useConfig = true,
} = {}) {
  const resolvedScriptDir = path.resolve(scriptDir);
  const resolvedConfigFile = path.resolve(
    nonEmpty(configFile) || nonEmpty(env.TUI_RUNTIME_CONFIG) || path.join(resolvedScriptDir, "runtime-paths.json"),
  );
  const config = useConfig ? readRuntimePathConfig(resolvedConfigFile) : null;
  const configBase = path.dirname(resolvedConfigFile);
  const cwd = process.cwd();

  const explicitCodexHome =
    optionValue(argv, "--codex-home") || nonEmpty(env.TUI_CODEX_HOME) || nonEmpty(env.CODEX_HOME);
  const codexHome = path.resolve(homeDir, explicitCodexHome || ".codex");
  const runtimeBase = path.join(codexHome, RUNTIME_DIR_NAME);

  const cliStateDir = optionValue(argv, "--state-dir");
  const envStateDir = nonEmpty(env.TUI_STATE_DIR);
  const configStateDir = nonEmpty(config && config.stateDir);
  let stateDir;
  let resolvedFrom;
  if (cliStateDir) {
    stateDir = absolutePath(cliStateDir, cwd);
    resolvedFrom = "cli";
  } else if (envStateDir) {
    stateDir = absolutePath(envStateDir, cwd);
    resolvedFrom = "environment";
  } else if (configStateDir) {
    stateDir = absolutePath(configStateDir, configBase);
    resolvedFrom = "runtime-config";
  } else {
    stateDir = path.join(runtimeBase, "state");
    resolvedFrom = "codex-home";
  }
  const stateOverridden = resolvedFrom === "cli" || resolvedFrom === "environment";

  const cliLockFile = optionValue(argv, "--lock-file");
  const envLockFile = nonEmpty(env.TUI_LOCK_FILE);
  const configLockFile = stateOverridden ? null : nonEmpty(config && config.lockFile);
  const lockFile = cliLockFile
    ? absolutePath(cliLockFile, cwd)
    : envLockFile
      ? absolutePath(envLockFile, cwd)
      : configLockFile
        ? absolutePath(configLockFile, configBase)
        : path.join(runtimeBase, "monitor.lock");

  const cliGuardLockFile = optionValue(argv, "--guard-lock-file");
  const envGuardLockFile = nonEmpty(env.TUI_GUARD_LOCK_FILE);
  const configGuardLockFile = nonEmpty(config && config.guardLockFile);
  const guardLockFile = cliGuardLockFile
    ? absolutePath(cliGuardLockFile, cwd)
    : envGuardLockFile
      ? absolutePath(envGuardLockFile, cwd)
      : configGuardLockFile
        ? absolutePath(configGuardLockFile, configBase)
        : path.join(homeDir, ".tokens-ui-for-codex", "monitor.guard.lock");

  const cliHeartbeatFile = optionValue(argv, "--heartbeat-file");
  const envHeartbeatFile = nonEmpty(env.TUI_HEARTBEAT_FILE);
  const configHeartbeatFile = nonEmpty(config && config.heartbeatFile);
  const heartbeatFile = cliHeartbeatFile
    ? absolutePath(cliHeartbeatFile, cwd)
    : envHeartbeatFile
      ? absolutePath(envHeartbeatFile, cwd)
      : configHeartbeatFile
        ? absolutePath(configHeartbeatFile, configBase)
        : path.join(stateDir, "monitor-heartbeat.json");

  const cliLogDir = optionValue(argv, "--log-dir");
  const envLogDir = nonEmpty(env.TUI_LOG_DIR);
  const configLogDir = stateOverridden ? null : nonEmpty(config && config.logDir);
  const logDir = cliLogDir
    ? absolutePath(cliLogDir, cwd)
    : envLogDir
      ? absolutePath(envLogDir, cwd)
      : configLogDir
        ? absolutePath(configLogDir, configBase)
        : path.join(stateDir, "logs");

  const cliHistoryDir = optionValue(argv, "--history-dir");
  const envHistoryDir = nonEmpty(env.TUI_HISTORY_DIR);
  const configHistoryDir = stateOverridden ? null : nonEmpty(config && config.historyDir);
  const historyDir = cliHistoryDir
    ? absolutePath(cliHistoryDir, cwd)
    : envHistoryDir
      ? absolutePath(envHistoryDir, cwd)
      : configHistoryDir
        ? absolutePath(configHistoryDir, configBase)
        : path.join(stateDir, "history");

  return {
    schemaVersion: RUNTIME_PATH_SCHEMA_VERSION,
    resolvedFrom,
    codexHome,
    stateDir,
    lockFile,
    guardLockFile,
    heartbeatFile,
    logDir,
    historyDir,
    configFile: resolvedConfigFile,
    configLoaded: !!config,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(
    JSON.stringify(
      resolveRuntimePaths({
        useConfig: !process.argv.includes("--ignore-config"),
      }),
      null,
      2,
    ) + "\n",
  );
}

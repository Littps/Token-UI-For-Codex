import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { resolveRuntimePaths } from "../runtime-paths.mjs";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tui-runtime-paths-"));
after(() => {
  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {}
});

test("runtime paths: default follows CODEX_HOME and keeps state outside LocalAppData", () => {
  const codexHome = path.join(testRoot, "custom codex");
  const result = resolveRuntimePaths({
    argv: [],
    env: { CODEX_HOME: codexHome },
    homeDir: path.join(testRoot, "home"),
    scriptDir: testRoot,
    configFile: path.join(testRoot, "no-config-default.json"),
  });
  assert.equal(result.resolvedFrom, "codex-home");
  assert.equal(result.stateDir, path.join(codexHome, "tokens-ui-for-codex", "state"));
  assert.equal(result.lockFile, path.join(codexHome, "tokens-ui-for-codex", "monitor.lock"));
  assert.equal(
    result.guardLockFile,
    path.join(path.join(testRoot, "home"), ".tokens-ui-for-codex", "monitor.guard.lock"),
  );
  assert.equal(result.heartbeatFile, path.join(result.stateDir, "monitor-heartbeat.json"));
  assert.equal(result.logDir, path.join(result.stateDir, "logs"));
  assert.equal(result.historyDir, path.join(result.stateDir, "history"));
});

test("runtime paths: CLI overrides environment and config", () => {
  const configFile = path.join(testRoot, "runtime-paths.json");
  fs.writeFileSync(
    configFile,
    "\uFEFF" +
      JSON.stringify({
        schemaVersion: 1,
        stateDir: "config-state",
        lockFile: "config-lock.json",
        guardLockFile: "config-guard.lock",
        heartbeatFile: "config-heartbeat.json",
        logDir: "config-logs",
        historyDir: "config-history",
      }),
    "utf8",
  );
  const cliState = path.join(testRoot, "cli state");
  const cliLock = path.join(testRoot, "cli lock.json");
  const result = resolveRuntimePaths({
    argv: ["--state-dir", cliState, "--lock-file", cliLock],
    env: { CODEX_HOME: path.join(testRoot, "codex"), TUI_STATE_DIR: path.join(testRoot, "env-state") },
    homeDir: testRoot,
    scriptDir: testRoot,
    configFile,
  });
  assert.equal(result.resolvedFrom, "cli");
  assert.equal(result.stateDir, cliState);
  assert.equal(result.lockFile, cliLock);
  assert.equal(result.logDir, path.join(cliState, "logs"));
  assert.equal(result.historyDir, path.join(cliState, "history"));
});

test("runtime paths: environment overrides runtime config", () => {
  const configFile = path.join(testRoot, "runtime-paths-env.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({ schemaVersion: 1, stateDir: "config-state", lockFile: "config-lock.json" }),
    "utf8",
  );
  const envState = path.join(testRoot, "env-state");
  const result = resolveRuntimePaths({
    argv: [],
    env: { CODEX_HOME: path.join(testRoot, "codex"), TUI_STATE_DIR: envState },
    homeDir: testRoot,
    scriptDir: testRoot,
    configFile,
  });
  assert.equal(result.resolvedFrom, "environment");
  assert.equal(result.stateDir, envState);
  assert.equal(result.lockFile, path.join(testRoot, "codex", "tokens-ui-for-codex", "monitor.lock"));
});

test("runtime paths: runtime config supports spaces and unicode", () => {
  const configFile = path.join(testRoot, "runtime-paths-unicode.json");
  const configuredState = path.join(testRoot, "跨设备 状态");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      schemaVersion: 1,
      stateDir: configuredState,
      lockFile: path.join(testRoot, "监控 lock.json"),
      guardLockFile: path.join(testRoot, "全局 guard.lock"),
      heartbeatFile: path.join(testRoot, "心跳.json"),
      logDir: path.join(testRoot, "日志"),
      historyDir: path.join(testRoot, "历史"),
    }),
    "utf8",
  );
  const result = resolveRuntimePaths({
    argv: [],
    env: {},
    homeDir: path.join(testRoot, "home"),
    scriptDir: testRoot,
    configFile,
  });
  assert.equal(result.resolvedFrom, "runtime-config");
  assert.equal(result.stateDir, configuredState);
  assert.equal(result.lockFile, path.join(testRoot, "监控 lock.json"));
  assert.equal(result.guardLockFile, path.join(testRoot, "全局 guard.lock"));
  assert.equal(result.heartbeatFile, path.join(testRoot, "心跳.json"));
  assert.equal(result.logDir, path.join(testRoot, "日志"));
  assert.equal(result.historyDir, path.join(testRoot, "历史"));
});

test("runtime paths: invalid config falls back to Codex home", () => {
  const configFile = path.join(testRoot, "invalid-runtime-paths.json");
  fs.writeFileSync(configFile, "{invalid", "utf8");
  const codexHome = path.join(testRoot, "fallback-codex");
  const result = resolveRuntimePaths({
    argv: [],
    env: { CODEX_HOME: codexHome },
    homeDir: path.join(testRoot, "home"),
    scriptDir: testRoot,
    configFile,
  });
  assert.equal(result.configLoaded, false);
  assert.equal(result.stateDir, path.join(codexHome, "tokens-ui-for-codex", "state"));
});

test("runtime paths: TUI_CODEX_HOME takes precedence over CODEX_HOME", () => {
  const preferred = path.join(testRoot, "portable codex");
  const result = resolveRuntimePaths({
    argv: [],
    env: {
      TUI_CODEX_HOME: preferred,
      CODEX_HOME: path.join(testRoot, "default codex"),
    },
    homeDir: path.join(testRoot, "home"),
    scriptDir: testRoot,
    configFile: path.join(testRoot, "no-config-preferred.json"),
  });
  assert.equal(result.codexHome, preferred);
  assert.equal(result.stateDir, path.join(preferred, "tokens-ui-for-codex", "state"));
});

test("runtime paths: installer can ignore an existing runtime config", () => {
  const configFile = path.join(testRoot, "runtime-paths-ignore.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({ schemaVersion: 1, stateDir: path.join(testRoot, "stale-state") }),
    "utf8",
  );
  const codexHome = path.join(testRoot, "fresh-codex");
  const result = resolveRuntimePaths({
    argv: [],
    env: { CODEX_HOME: codexHome },
    homeDir: path.join(testRoot, "home"),
    scriptDir: testRoot,
    configFile,
    useConfig: false,
  });
  assert.equal(result.configLoaded, false);
  assert.equal(result.resolvedFrom, "codex-home");
  assert.equal(result.stateDir, path.join(codexHome, "tokens-ui-for-codex", "state"));
});

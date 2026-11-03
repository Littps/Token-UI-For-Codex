// 固定合成 fixture 的完整 buildStats() 输出快照。
// 用法：node scripts/stats-snapshot.mjs --write | --check

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotDir = path.join(root, "test", "snapshots", "stats");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tui-stats-snapshot-"));
process.env.TZ = "Asia/Shanghai";
process.env.CODEX_HOME = path.join(stateRoot, "codex");
process.env.LOCALAPPDATA = stateRoot;
process.env.APPDATA = stateRoot;
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
process.env.TUI_TOKENS_AS_MODULE = "1";

const { buildStats } = await import("../token-stats.mjs");

function usage(ts, id, values) {
  const input = values.input ?? 100;
  const output = values.output ?? 20;
  const cached = values.cached ?? 50;
  return {
    ts,
    ordinal: values.ordinal ?? 1,
    genMs: values.genMs ?? 1000,
    responseId: id,
    turnId: values.turnId ?? "turn-1",
    model: values.model ?? "fixture-model",
    input,
    output,
    cached,
    total: input + output,
    turnUsage: {
      input,
      output,
      cached,
      total: values.turnTotal ?? input + output,
    },
    threadUsage: {
      input,
      output,
      cached,
      total: values.threadTotal ?? input + output,
    },
  };
}

function count(ts, values) {
  const input = values.input ?? 80;
  const output = values.output ?? 20;
  const cached = values.cached ?? 40;
  return {
    ts,
    ordinal: values.ordinal ?? 1,
    genMs: values.genMs ?? 1000,
    total: values.threadTotal ?? input + output,
    input,
    output,
    cached,
    lastTotal: input + output,
    totalInfo: { input, output, cached },
  };
}

function parsed(values) {
  return {
    file: "fixture.jsonl",
    threadId: "fixture-thread",
    date: "2026-10-20",
    counts: values.counts || [],
    usageRecords: values.usageRecords || [],
    userMessages: values.userMessages || [{ ts: "2026-10-20T00:00:00.000Z", ordinal: 0 }],
    turnContexts: values.turnContexts || [{ ts: "2026-10-20T00:00:00.000Z", ordinal: 0, turnId: "turn-1" }],
    taskCompletions: values.taskCompletions || [],
    itemTimings: values.itemTimings || [],
    taskRunning: false,
    modelContextWindow: values.modelContextWindow ?? 1000,
    modelChanges: values.modelChanges || [{ ts: "2026-10-20T00:00:00.000Z", model: "fixture-model" }],
    formatConflicts: values.formatConflicts || 0,
  };
}

const fixtures = {
  "modern-only": parsed({
    usageRecords: [
      usage("2026-10-20T00:00:01.000Z", "modern-1", { threadTotal: 120 }),
      usage("2026-10-20T00:00:02.000Z", "modern-2", { input: 130, output: 30, cached: 70, threadTotal: 280 }),
    ],
  }),
  "legacy-only": parsed({
    counts: [
      count("2026-10-20T00:00:01.000Z", { threadTotal: 100 }),
      count("2026-10-20T00:00:02.000Z", { input: 120, output: 30, cached: 60, threadTotal: 250 }),
    ],
  }),
  "mixed-reset": parsed({
    usageRecords: [
      usage("2026-10-20T00:00:01.000Z", "mixed-1", { threadTotal: 500 }),
      usage("2026-10-20T00:00:03.000Z", "mixed-3", { input: 50, output: 10, cached: 20, threadTotal: 60 }),
    ],
    counts: [count("2026-10-20T00:00:02.000Z", { input: 100, output: 20, cached: 40, threadTotal: 620 })],
  }),
  "out-of-order": parsed({
    usageRecords: [
      usage("2026-10-20T00:00:03.000Z", "order-2", { threadTotal: 260 }),
      usage("2026-10-20T00:00:01.000Z", "order-1", { threadTotal: 120 }),
    ],
  }),
  "tool-timing": parsed({
    usageRecords: [usage("2026-10-20T00:00:10.000Z", "timed-1", { input: 200, output: 100, cached: 100 })],
    taskCompletions: [
      {
        turnId: "turn-1",
        ts: "2026-10-20T00:00:11.000Z",
        startedAt: "2026-10-20T00:00:00.000Z",
        completedAt: "2026-10-20T00:00:10.000Z",
        durationMs: 10000,
        ttftMs: 1000,
      },
    ],
    itemTimings: [
      {
        turnId: "turn-1",
        ts: "2026-10-20T00:00:07.000Z",
        itemType: "CommandExecution",
        durationMs: 2000,
        startedAtMs: 5000,
        completedAtMs: 7000,
      },
      {
        turnId: "turn-1",
        ts: "2026-10-20T00:00:10.000Z",
        itemType: "AgentMessage",
        durationMs: 4000,
        startedAtMs: 6000,
        completedAtMs: 10000,
      },
    ],
  }),
};

function normalizedStats(stats) {
  // Keep the original v4 numeric baseline unchanged. v5 model/cost additions
  // have independent parser, history, protocol and UI assertions; only these
  // named additions are omitted here, never an existing statistic or value.
  const modelCostFields = new Set([
    "modelUsage",
    "modelId",
    "modelLabel",
    "openRouterReferenceUsd",
    "pricingFetchedAt",
    "costStatus",
    "cacheWrite",
    "cacheWrite30m",
    "cacheWrite12h",
  ]);
  const stable = JSON.parse(JSON.stringify(stats, (key, value) => (modelCostFields.has(key) ? undefined : value)));
  delete stable.file;
  delete stable.threadId;
  delete stable.date;
  delete stable.archiveRecords;
  return stable;
}

function serialized(name) {
  return JSON.stringify(normalizedStats(buildStats(fixtures[name], { retainRequests: false })), null, 2) + "\n";
}

const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : null;
if (!mode) {
  console.error("用法: node scripts/stats-snapshot.mjs --write | --check");
  process.exit(2);
}

fs.mkdirSync(snapshotDir, { recursive: true });
let failures = 0;
try {
  for (const name of Object.keys(fixtures)) {
    const expectedPath = path.join(snapshotDir, name + ".json");
    const actual = serialized(name);
    if (mode === "write") {
      fs.writeFileSync(expectedPath, actual, "utf8");
      continue;
    }
    const expected = fs.existsSync(expectedPath) ? fs.readFileSync(expectedPath, "utf8").replace(/\r\n/g, "\n") : "";
    if (expected !== actual) {
      failures += 1;
      console.error("stats snapshot mismatch: " + name);
    }
  }
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
}

if (failures > 0) process.exitCode = 1;
else console.log(mode === "write" ? "stats snapshots written" : "stats snapshots match");

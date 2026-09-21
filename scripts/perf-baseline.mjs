import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const countArg = Number(process.argv[2]);
const recordCount = Number.isInteger(countArg) && countArg > 0 ? countArg : 20000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokens-ui-perf-"));
process.env.CODEX_HOME = path.join(root, "codex");
process.env.LOCALAPPDATA = path.join(root, "local");
process.env.APPDATA = path.join(root, "roaming");
process.env.TUI_TOKENS_AS_MODULE = "1";
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

const { IncrementalRolloutParser, buildStats } = await import("../token-stats.mjs");
const file = path.join(root, "rollout-2026-09-16T12-00-00-perf-thread.jsonl");

function makeRecord(index, total) {
  const second = String(index % 60).padStart(2, "0");
  const minute = String(Math.floor(index / 60) % 60).padStart(2, "0");
  const hour = String(12 + Math.floor(index / 3600)).padStart(2, "0");
  return JSON.stringify({
    timestamp: `2026-09-16T${hour}:${minute}:${second}.000Z`,
    type: "token_usage_record",
    payload: {
      response_id: `perf-${index}`,
      turn_id: "perf-turn",
      usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50, total_tokens: 120 },
      turn_token_usage: { input_tokens: index * 100, output_tokens: index * 20, cached_input_tokens: index * 50, total_tokens: index * 120 },
      thread_token_usage: { input_tokens: index * 100, output_tokens: index * 20, cached_input_tokens: index * 50, total_tokens: total },
    },
  });
}

try {
  const lines = [];
  for (let index = 1; index <= recordCount; index += 1) lines.push(makeRecord(index, index * 120));
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  const parser = new IncrementalRolloutParser(file);
  const startMemory = process.memoryUsage().heapUsed;
  const initialStart = performance.now();
  const parsed = parser.readNew();
  const initialParseMs = performance.now() - initialStart;
  const initialStatsStart = performance.now();
  const initialStats = buildStats(parsed, { retainRequests: false });
  const initialStatsMs = performance.now() - initialStatsStart;

  const appendStart = performance.now();
  fs.appendFileSync(file, makeRecord(recordCount + 1, (recordCount + 1) * 120) + "\n", "utf8");
  const appended = parser.readNew();
  const appendParseMs = performance.now() - appendStart;
  const appendStatsStart = performance.now();
  const appendedStats = buildStats(appended, { retainRequests: false });
  const appendStatsMs = performance.now() - appendStatsStart;
  const endMemory = process.memoryUsage().heapUsed;

  console.log(JSON.stringify({
    recordCount,
    initialParseMs: Number(initialParseMs.toFixed(3)),
    initialStatsMs: Number(initialStatsMs.toFixed(3)),
    appendParseMs: Number(appendParseMs.toFixed(3)),
    appendStatsMs: Number(appendStatsMs.toFixed(3)),
    heapDeltaMb: Number(((endMemory - startMemory) / 1024 / 1024).toFixed(3)),
    requestCount: appendedStats.requestCount,
    sessionTotal: appendedStats.sessionTotal,
    retainedRequestDetails: appendedStats.turns.at(-1)?.requests.length || 0,
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

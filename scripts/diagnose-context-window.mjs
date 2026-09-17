// 只读取证：会话日志里 model_context_window 到底出现在哪里、出现的顺序如何。
// 只输出结构化元数据（事件类型、字段位置、数值、序号），不输出任何消息正文、路径或线程 ID。
// 用法：node scripts/diagnose-context-window.mjs [--files 3]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
let fileCount = 3;
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--files" && Number.isInteger(Number(argv[index + 1]))) fileCount = Number(argv[index + 1]);
}

const sessionsDir = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  "sessions",
);

function listRolloutFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listRolloutFiles(full, out);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = listRolloutFiles(sessionsDir)
  .map((file) => {
    try {
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => b.mtimeMs - a.mtimeMs)
  .slice(0, fileCount);

const report = { sessionsDirFound: fs.existsSync(sessionsDir), filesScanned: files.length, files: [] };

for (const entry of files) {
  const stats = {
    datePrefix: path.basename(entry.file).slice(0, 27),
    lineCount: 0,
    eventTypes: {},
    windowOccurrences: [],
    ordinalFirstUsageRecord: null,
    ordinalFirstTokenCountWindow: null,
    ordinalFirstTurnContextWindow: null,
  };

  let text;
  try {
    text = fs.readFileSync(entry.file, "utf8");
  } catch (error) {
    stats.error = error.message;
    report.files.push(stats);
    continue;
  }

  let ordinal = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    ordinal += 1;
    stats.lineCount = ordinal;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const type = event.type || "(none)";
    const payloadType = event.payload && event.payload.type ? event.payload.type : "";
    const key = payloadType ? type + "/" + payloadType : type;
    stats.eventTypes[key] = (stats.eventTypes[key] || 0) + 1;

    if (type === "token_usage_record" && stats.ordinalFirstUsageRecord === null) {
      stats.ordinalFirstUsageRecord = ordinal;
    }

    const payload = event.payload || {};
    const info = payload.info || {};
    const candidates = [];
    if (Number.isFinite(payload.model_context_window)) {
      candidates.push({ location: type + ".payload.model_context_window", value: payload.model_context_window });
    }
    if (Number.isFinite(info.model_context_window)) {
      candidates.push({ location: type + ".payload.info.model_context_window", value: info.model_context_window });
    }
    if (payload.context_window && Number.isFinite(payload.context_window.limit_tokens)) {
      candidates.push({ location: type + ".payload.context_window.limit_tokens", value: payload.context_window.limit_tokens });
    }

    for (const candidate of candidates) {
      if (stats.windowOccurrences.length < 20) {
        stats.windowOccurrences.push({ ordinal, ...candidate, payloadType });
      }
      if (candidate.location.endsWith("info.model_context_window") && stats.ordinalFirstTokenCountWindow === null) {
        stats.ordinalFirstTokenCountWindow = ordinal;
      }
      if (candidate.location === "turn_context.payload.model_context_window" && stats.ordinalFirstTurnContextWindow === null) {
        stats.ordinalFirstTurnContextWindow = ordinal;
      }
    }
  }

  stats.conclusion = {
    hasAnyWindow: stats.windowOccurrences.length > 0,
    windowBeforeFirstUsageRecord:
      stats.ordinalFirstUsageRecord !== null &&
      stats.windowOccurrences.some((item) => item.ordinal < stats.ordinalFirstUsageRecord),
    windowAfterFirstUsageRecord:
      stats.ordinalFirstUsageRecord !== null &&
      stats.windowOccurrences.some((item) => item.ordinal > stats.ordinalFirstUsageRecord),
  };
  report.files.push(stats);
}

console.log(JSON.stringify(report, null, 2));

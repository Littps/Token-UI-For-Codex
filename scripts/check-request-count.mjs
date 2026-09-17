// 只读核对：当前会话的"请求次数"是否与日志真实事件数一致。
// 输出结构化计数，不打印任何消息正文。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CCM_TOKENS_AS_MODULE = "1";
const stats = await import("../token-stats.mjs");

const sessionsDir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
const walk = (dir, out = []) => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(full);
  }
  return out;
};

const newest = walk(sessionsDir)
  .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
  .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

const parsed = stats.parseFile(newest.file);
const result = stats.buildStats(parsed, { retainRequests: false });
// 逐请求 total 前缀和：新格式本体（已按 response_id 去重）的 usage.total_tokens 之和。
const modernPerRequestSum = parsed.usageRecords.reduce(
  (sum, record) => sum + (Number.isFinite(record.total) ? record.total : 0),
  0,
);

// 原始事件计数（未去重前的真实条数）
let usageRecordLines = 0;
let tokenCountLines = 0;
let firstTs = null;
let lastTs = null;
for (const line of fs.readFileSync(newest.file, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  if (line.includes('"token_usage_record"')) usageRecordLines += 1;
  if (line.includes('"token_count"')) tokenCountLines += 1;
  const match = line.match(/"timestamp":"([^"]+)"/);
  if (match) {
    if (!firstTs) firstTs = match[1];
    lastTs = match[1];
  }
}

console.log(JSON.stringify({
  file: path.basename(newest.file).slice(0, 27) + "…",
  window: { firstTs, lastTs },
  raw: { usageRecordLines, tokenCountLines },
  parsedAfterDedupe: {
    usageRecords: parsed.usageRecords.length,
    counts: parsed.counts.length,
  },
  // 一对一认领的三类分类（会话级，与参考脚本 classify.cjs 对照）。
  classification: {
    echo: result.echoStats.total,
    replay: result.replayStats.count,
    unique: result.uniqueStats.count,
    uniqueSelfDuplicate: result.uniqueStats.selfDuplicate,
    legacyRaw: result.legacyStats.raw,
    legacyDeduped: result.legacyStats.deduped,
    claimedModern: result.legacyStats.claimedModern,
    modernKept: parsed.usageRecords.length,
  },
  statsRequestCount: result.requestCount,
  sessionTotal: result.sessionTotal,
  prefixSum: {
    modernPerRequestSum,
    sessionTotalMinusSum: result.sessionTotal - modernPerRequestSum,
  },
  echoStats: result.echoStats,
  replayStats: result.replayStats,
  formatConflictCount: result.formatConflictCount,
  acceptance: {
    // 结构断言（见 docs/F1-merge-spec.md）：全部必须为 true；比例用 1%，lagMaxMs 只作观测、不写死数值。
    echoEqualsClaimedModern: result.echoStats.total === result.legacyStats.claimedModern,
    classesSumEqualsLegacyDeduped: result.echoStats.total + result.replayStats.count + result.uniqueStats.count === result.legacyStats.deduped,
    legacyDedupedPlusSelfDuplicateEqualsRaw: result.legacyStats.deduped + result.uniqueStats.selfDuplicate === result.legacyStats.raw,
    requestCountEqualsModernPlusUnique: result.requestCount === parsed.usageRecords.length + result.uniqueStats.count,
    sessionTotalMatchesPrefixSum: result.sessionTotal === modernPerRequestSum,
    trueConflictsZero: result.formatConflictCount === 0,
    overThresholdRatioWithinOnePercent: result.echoStats.total > 0
      ? result.echoStats.overThreshold / result.echoStats.total <= 0.01
      : false,
    overThresholdRatio: result.echoStats.total > 0
      ? Number((result.echoStats.overThreshold / result.echoStats.total).toFixed(5))
      : null,
  },
  turns: result.turns.length,
}, null, 2));

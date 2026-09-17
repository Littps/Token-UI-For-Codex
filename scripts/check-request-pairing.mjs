// 只读核对：token_usage_record(C) 与 token_count(R) 是否成对描述同一次请求。
// 只输出时间戳与 token 数字，不输出消息正文。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const sequence = [];
for (const line of fs.readFileSync(newest.file, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const isRecord = line.includes("\"token_usage_record\"");
  const isCount = line.includes("\"token_count\"");
  if (!isRecord && !isCount) continue;
  const timestamp = (line.match(/"timestamp":"([^"]+)"/) || [])[1] || "";
  let cumulative = null;
  try {
    const parsed = JSON.parse(line);
    if (isRecord) cumulative = parsed.payload.thread_token_usage ? parsed.payload.thread_token_usage.total_tokens : null;
    else cumulative = parsed.payload.info.total_token_usage ? parsed.payload.info.total_token_usage.total_tokens : null;
  } catch {}
  sequence.push({
    kind: isRecord ? "R" : "C",
    ts: timestamp,
    cumulative: Number.isFinite(cumulative) ? cumulative : null,
  });
}

// 统计两种事件的时间分布与相邻配对情况
let pairs = 0;
let recordOnly = 0;
let countOnly = 0;
for (let index = 0; index < sequence.length; index += 1) {
  const current = sequence[index];
  const next = sequence[index + 1];
  if (current.kind === "R" && next && next.kind === "C") { pairs += 1; index += 1; }
  else if (current.kind === "R") recordOnly += 1;
  else countOnly += 1;
}

const firstR = sequence.find((item) => item.kind === "R");
const firstC = sequence.find((item) => item.kind === "C");

console.log(JSON.stringify({
  file: path.basename(newest.file).slice(0, 27) + "…",
  totals: { records: sequence.filter((item) => item.kind === "R").length, counts: sequence.filter((item) => item.kind === "C").length },
  firstRecordTs: firstR ? firstR.ts : null,
  firstCountTs: firstC ? firstC.ts : null,
  adjacentPairs_R_then_C: pairs,
  recordWithoutImmediateCount: recordOnly,
  countWithoutImmediateRecord: countOnly,
  pairValueComparison: (() => {
    const rows = [];
    for (let index = 0; index < sequence.length - 1 && rows.length < 8; index += 1) {
      if (sequence[index].kind === "R" && sequence[index + 1].kind === "C") {
        rows.push({ recordCumulative: sequence[index].cumulative, countCumulative: sequence[index + 1].cumulative, equal: sequence[index].cumulative === sequence[index + 1].cumulative });
        index += 1;
      }
    }
    return rows;
  })(),
  sample: sequence.slice(0, 6).concat(sequence.slice(-4)),
}, null, 2));

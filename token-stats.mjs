#!/usr/bin/env node
// ccm-token-spend / token-stats.mjs
//
// Reads Codex session rollout files (~/.codex/sessions/**/rollout-*.jsonl) and
// reports per-request / per-turn / per-conversation token consumption.
//
// Usage:
//   node token-stats.mjs                    stats for the most recent conversation
//   node token-stats.mjs --thread <id>      stats for a specific conversation
//   node token-stats.mjs --all              per-conversation totals across all sessions
//   node token-stats.mjs --detail           include per-request rows in the printed table
//   node token-stats.mjs --watch [--cdp]    watch the active conversation (push to page with --cdp)
//   node token-stats.mjs --cdp              one-shot push of a sanitized summary into the Codex page
//   node token-stats.mjs --port <port>      CDP port override (default 9229)
//
// The tool only reads Codex's own session logs and never prints secrets.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROTOCOL_NAME,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_SCHEMA_VERSION,
  makeHealth,
  normalizeHealth,
  validatePayload,
} from "./protocol.mjs";

const SESSIONS_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
const ROLLOUT_RE = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)\.jsonl$/;
const ROLLOUT_FILE_RE = /^rollout-.*\.jsonl$/;
const ROLLOUT_FILE_LIST_CACHE_MS = 1500;
const MAX_TURN_SUMMARIES = 200;
const ACTIVE_ID_CACHE_MS = 15000;
const THREAD_PROBE_INTERVAL_MS = 2000;
// 数据变化时立即推送；无变化时按固定周期推送，保证页面每 5 秒至少刷新一次。
const HEARTBEAT_INTERVAL_MS = 5000;
const STALE_DATA_AFTER_MS = 15000;
// 错峰回声属正常现象（legacy 流落后于新格式流），只做健康度观测：同内容（回声）的两条事件
// 时间差超过该阈值才算"信号"，否则算噪声。本机实测：>5s 是噪声量级，>60s 才值得看，故取 60 秒。
const ECHO_LAG_THRESHOLD_MS = 60000;
// 验收口径（会话级，见 docs/F1-merge-spec.md）：
//   结构断言：一对一认领（echo = 被认领本体数）、echo + replay + unique = legacy 去重后、
//             formatConflictCount = 0、sessionTotal = 逐请求 total 前缀和（偏差 0）；
//   比例断言：echoStats.overThreshold / echoStats.total ≤ 1%（当前实测 6 / 1134 = 0.53%）；
//   分类数须与参考脚本 classify.cjs / lag-methods.cjs 在同一会话文件上逐项一致。
// lagMaxMs 只作观测，不写死具体数值（它随会话长度自然增长）；replay 陈旧度另计 replayStats。
const DEFAULT_TARGET_SELECTOR = "auto";
const FILE_FINGERPRINT_BYTES = 4096;
const LOCAL_ROOT_DIR = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const STATE_DIR_NAME = "tokens-ui-for-codex";
// 早期版本用的是 ccm-token-spend 目录，启动时一次性迁移，避免历史日志与对话映射丢失
const LEGACY_STATE_DIR_NAME = "ccm-token-spend";
const LOCAL_STATE_DIR = path.join(LOCAL_ROOT_DIR, STATE_DIR_NAME);
const LEGACY_STATE_DIR = path.join(LOCAL_ROOT_DIR, LEGACY_STATE_DIR_NAME);

function migrateLegacyStateDir() {
  try {
    if (fs.existsSync(LOCAL_STATE_DIR)) return;
    if (!fs.existsSync(LEGACY_STATE_DIR)) return;
    fs.renameSync(LEGACY_STATE_DIR, LOCAL_STATE_DIR);
  } catch {
    // 迁移失败（例如旧目录被占用）不算致命：直接使用新目录即可，旧数据留在原地
  }
}

migrateLegacyStateDir();

// 单实例锁：计划任务、兜底巡检、手动启动都可能同时拉起监控，这里保证只保留一个。
// Node 没有 flock，因此用「PID 锁文件 + 存活探测」：持有者进程不存在时视为陈旧锁并接管。
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM"; // 存在但无权限 → 仍视为存活
  }
}

function acquireSingleInstanceLock() {
  const lockFile = path.join(LOCAL_STATE_DIR, "monitor.lock");
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try {
    fs.mkdirSync(LOCAL_STATE_DIR, { recursive: true });
    fs.writeFileSync(lockFile, payload, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (!error || error.code !== "EEXIST") return true; // 其它异常不阻塞启动
  }
  try {
    const held = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (held && Number.isInteger(held.pid) && isProcessAlive(held.pid)) return false;
  } catch {
    // 锁文件损坏 → 按陈旧锁处理
  }
  try {
    fs.writeFileSync(lockFile, payload, "utf8");
  } catch {
    // 覆盖失败也无妨，下一轮再试
  }
  return true;
}
const MONITOR_HEALTH_FILE = path.join(LOCAL_STATE_DIR, "monitor-health.json");
const AUTOSTART_STATE_FILE = path.join(LOCAL_STATE_DIR, "autostart-state.json");
const LOG_DIR = path.join(LOCAL_STATE_DIR, "logs");
const LOG_ROTATE_BYTES = 1024 * 1024;
const MAX_LOG_FILES = 30;
const CODEX_PLUS_PLUS_USER_SCRIPTS = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "Codex++",
  "user_scripts",
);
let currentTargetSelector = DEFAULT_TARGET_SELECTOR;
const MAX_MODEL_SEGMENTS = 32;

let rolloutFilesCache = null;
let rolloutFilesCacheAt = 0;
let rolloutFileIndex = new Map();

// ---------------------------------------------------------------------------
// 会话文件发现
//
// 会话目录是 <sessions>/<年>/<月>/<日>/rollout-*.jsonl 的树形结构。
// 发现结果带 1.5 秒缓存：watch 模式每秒都会问一次，缓存把目录遍历摊薄掉。
// ---------------------------------------------------------------------------

// 递归收集 rollout 文件；跳过符号链接目录，避免环形链接导致无限下钻。
function collectRolloutFiles(root) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在或不可读（开始/结束竞态），跳过
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink()) pending.push(full);
      } else if (entry.isFile() && ROLLOUT_FILE_RE.test(entry.name)) {
        found.push(full);
      }
    }
  }
  return found;
}

function findRolloutFiles() {
  const stamp = Date.now();
  if (rolloutFilesCache && stamp - rolloutFilesCacheAt < ROLLOUT_FILE_LIST_CACHE_MS) {
    return [...rolloutFilesCache];
  }

  const collected = fs.existsSync(SESSIONS_DIR) ? collectRolloutFiles(SESSIONS_DIR) : [];
  rolloutFilesCache = collected;
  rolloutFilesCacheAt = stamp;
  // 重建 threadId → 文件索引；同一 thread 出现多份时保留最后一个（与发现顺序一致）
  rolloutFileIndex = new Map();
  for (const file of collected) {
    const id = threadIdOf(file);
    if (id) rolloutFileIndex.set(id, file);
  }
  return [...collected];
}

function rolloutNameMatch(file) {
  return path.basename(file).match(ROLLOUT_RE);
}

function threadIdOf(file) {
  const matched = rolloutNameMatch(file);
  return matched ? matched[2] : null;
}

function fileDate(file) {
  const matched = rolloutNameMatch(file);
  return matched ? matched[1] : null;
}

function filePrefixFingerprint(file, length = FILE_FINGERPRINT_BYTES) {
  if (!Number.isInteger(length) || length <= 0) return "";
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return bytesRead + ":" + buffer.subarray(0, bytesRead).toString("base64");
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function modelValueFromEvent(event) {
  const payload = event && event.payload;
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["model", "model_slug", "model_name"]) {
    if (typeof payload[key] === "string" && payload[key].trim() && payload[key].length <= 128) return payload[key].trim();
  }
  return null;
}

function processParserEvent(state, event) {
  if (!event || typeof event !== "object") return;
  const timestamp = typeof event.timestamp === "string" ? event.timestamp : "";
  if (timestamp && timestamp > state.lastTimestamp) state.lastTimestamp = timestamp;

  const eventModel = modelValueFromEvent(event);
  if (eventModel && eventModel !== state.currentModel) {
    state.currentModel = eventModel;
    if (state.modelChanges.length < MAX_MODEL_SEGMENTS) state.modelChanges.push({ ts: timestamp, model: eventModel });
  }

  if (event.type === "turn_context" && event.payload && Number.isFinite(event.payload.model_context_window)) {
    state.modelContextWindow = event.payload.model_context_window;
  }

  // 上下文上限在真实日志里出现在 event_msg 上：
  //   1) payload.type === "task_started"  → payload.model_context_window
  //   2) payload.type === "token_count"   → payload.info.model_context_window
  // 这里必须先于任何提前 return 提取，否则新格式日志（已存在 token_usage_record）会永远取不到上限。
  if (event.type === "event_msg" && event.payload) {
    const windowPayload = event.payload;
    if (Number.isFinite(windowPayload.model_context_window)) {
      state.modelContextWindow = windowPayload.model_context_window;
    }
    if (windowPayload.info && Number.isFinite(windowPayload.info.model_context_window)) {
      state.modelContextWindow = windowPayload.info.model_context_window;
    }
  }

  if (event.type === "response_item" && event.payload && event.payload.role === "user") {
    if (timestamp && !state.userMessageKeys.has(timestamp)) {
      state.userMessageKeys.add(timestamp);
      state.userMessages.push({ ts: timestamp });
    }
    return;
  }

  if (event.type === "token_usage_record" && event.payload) {
    const payload = event.payload;
    const usage = payload.usage || {};
    const turnUsage = payload.turn_token_usage || {};
    const threadUsage = payload.thread_token_usage || {};
    const responseId = typeof payload.response_id === "string" ? payload.response_id : "";
    const recordKey = responseId || JSON.stringify([timestamp, payload.turn_id || "", usage.total_tokens ?? null]);
    if (state.usageRecordIds.has(recordKey)) {
      // 同 response_id（或指纹）重复：只算一次；数值不同则记一次真冲突。
      const firstTotal = state.usageRecordTotals.get(recordKey);
      const nextTotal = Number.isFinite(threadUsage.total_tokens) ? threadUsage.total_tokens : null;
      if (firstTotal != null && nextTotal != null && firstTotal !== nextTotal) state.formatConflicts += 1;
      return;
    }
    state.usageRecordIds.add(recordKey);
    state.usageRecordTotals.set(recordKey, Number.isFinite(threadUsage.total_tokens) ? threadUsage.total_tokens : null);
    state.usageRecords.push({
      ts: timestamp,
      responseId,
      turnId: typeof payload.turn_id === "string" ? payload.turn_id : "",
      model: state.currentModel,
      input: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
      output: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null,
      cached: Number.isFinite(usage.cached_input_tokens) ? usage.cached_input_tokens : null,
      total: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null,
      turnUsage: {
        input: Number.isFinite(turnUsage.input_tokens) ? turnUsage.input_tokens : null,
        output: Number.isFinite(turnUsage.output_tokens) ? turnUsage.output_tokens : null,
        cached: Number.isFinite(turnUsage.cached_input_tokens) ? turnUsage.cached_input_tokens : null,
        total: Number.isFinite(turnUsage.total_tokens) ? turnUsage.total_tokens : null,
      },
      threadUsage: {
        input: Number.isFinite(threadUsage.input_tokens) ? threadUsage.input_tokens : null,
        output: Number.isFinite(threadUsage.output_tokens) ? threadUsage.output_tokens : null,
        cached: Number.isFinite(threadUsage.cached_input_tokens) ? threadUsage.cached_input_tokens : null,
        total: Number.isFinite(threadUsage.total_tokens) ? threadUsage.total_tokens : null,
      },
    });
    return;
  }

  if (event.type !== "event_msg" || !event.payload) return;
  const payload = event.payload;
  if (payload.type === "user_message") {
    if (timestamp && !state.userMessageKeys.has(timestamp)) {
      state.userMessageKeys.add(timestamp);
      state.userMessages.push({ ts: timestamp });
    }
    return;
  }
  // 旧格式计数必须始终保留：混合日志（引擎升级/回退）下不能因为存在新格式记录就整体丢弃。
  if (payload.type !== "token_count" || !payload.info) return;
  const info = payload.info;
  if (Number.isFinite(info.model_context_window)) state.modelContextWindow = info.model_context_window;
  const last = info.last_token_usage || {};
  const count = {
    ts: timestamp,
    total: info.total_token_usage && Number.isFinite(info.total_token_usage.total_tokens) ? info.total_token_usage.total_tokens : null,
    input: Number.isFinite(last.input_tokens) ? last.input_tokens : null,
    output: Number.isFinite(last.output_tokens) ? last.output_tokens : null,
    cached: Number.isFinite(last.cached_input_tokens) ? last.cached_input_tokens : null,
    lastTotal: Number.isFinite(last.total_tokens) ? last.total_tokens : null,
    totalInfo: {
      input: info.total_token_usage && Number.isFinite(info.total_token_usage.input_tokens) ? info.total_token_usage.input_tokens : null,
      cached: info.total_token_usage && Number.isFinite(info.total_token_usage.cached_input_tokens) ? info.total_token_usage.cached_input_tokens : null,
      output: info.total_token_usage && Number.isFinite(info.total_token_usage.output_tokens) ? info.total_token_usage.output_tokens : null,
    },
  };
  const countKey = JSON.stringify([count.ts, count.total, count.input, count.output, count.cached, count.lastTotal, count.totalInfo.input, count.totalInfo.cached, count.totalInfo.output]);
  if (countKey !== state.previousCountKey) {
    state.previousCountKey = countKey;
    state.counts.push(count);
  }
}

class IncrementalRolloutParser {
  constructor(file) {
    this.file = file;
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.pending = "";
    this.pendingFinalized = false;
    this.decoder = new TextDecoder("utf-8");
    this.lastMtimeMs = 0;
    this.lastBirthtimeMs = 0;
    this.lastIno = null;
    this.filePrefixLength = 0;
    this.filePrefixFingerprint = "";
    this.lastTimestamp = "";
    this.counts = [];
    this.usageRecords = [];
    this.usageRecordIds = new Set();
    // 同 response_id 的重复记录只算一次；但若两次的线程累计不同，说明是"真冲突"（非 0 即报警）。
    this.usageRecordTotals = new Map();
    this.formatConflicts = 0;
    this.userMessages = [];
    this.userMessageKeys = new Set();
    this.modelChanges = [];
    this.currentModel = null;
    this.modelContextWindow = null;
    this.previousCountKey = null;
    this.snapshotCache = null;
    this.dirty = true;
  }

  readAll() {
    this.reset();
    return this.readNew();
  }

  readNew() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return null;
    }
    let prefixChanged = false;
    if (this.offset > 0 && this.filePrefixLength > 0 && stat.size >= this.filePrefixLength) {
      const currentPrefix = filePrefixFingerprint(this.file, this.filePrefixLength);
      prefixChanged = currentPrefix == null || currentPrefix !== this.filePrefixFingerprint;
    }
    const fileRecreated = this.offset > stat.size ||
      (this.lastBirthtimeMs && stat.birthtimeMs && this.lastBirthtimeMs !== stat.birthtimeMs) ||
      (this.lastIno != null && stat.ino != null && this.lastIno !== stat.ino) ||
      prefixChanged;
    if (fileRecreated) {
      this.reset();
      stat = fs.statSync(this.file);
    }
    if (stat.size === this.offset) {
      this.lastMtimeMs = stat.mtimeMs;
      this.lastBirthtimeMs = stat.birthtimeMs;
      this.lastIno = stat.ino ?? null;
      return this.toParsed();
    }

    let fd;
    try {
      this.pendingFinalized = false;
      fd = fs.openSync(this.file, "r");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = this.offset;
      while (position < stat.size) {
        const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!bytesRead) break;
        position += bytesRead;
        this.pending += this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        let newline;
        while ((newline = this.pending.indexOf("\n")) >= 0) {
          const line = this.pending.slice(0, newline).replace(/\r$/, "");
          this.pending = this.pending.slice(newline + 1);
          if (line.trim()) {
            try { processParserEvent(this, JSON.parse(line)); } catch {}
          }
        }
      }
      if (this.pending.trim() && !this.pendingFinalized) {
        try {
          processParserEvent(this, JSON.parse(this.pending));
          this.pending = "";
          this.pendingFinalized = true;
        } catch {}
      }
      this.offset = position;
      this.lastMtimeMs = stat.mtimeMs;
      this.lastBirthtimeMs = stat.birthtimeMs;
      this.lastIno = stat.ino ?? null;
      this.dirty = true;
    } catch {
      return null;
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
    this.filePrefixLength = Math.min(stat.size, FILE_FINGERPRINT_BYTES);
    this.filePrefixFingerprint = this.filePrefixLength > 0
      ? filePrefixFingerprint(this.file, this.filePrefixLength) || ""
      : "";
    return this.toParsed();
  }

  toParsed() {
    if (!this.dirty && this.snapshotCache) return this.snapshotCache;
    if (!this.counts.length && !this.usageRecords.length && !this.userMessages.length) {
      this.snapshotCache = null;
      this.dirty = false;
      return null;
    }
    this.snapshotCache = {
      file: this.file,
      threadId: threadIdOf(this.file),
      date: fileDate(this.file),
      counts: this.counts,
      usageRecords: this.usageRecords,
      userMessages: this.userMessages,
      modelContextWindow: this.modelContextWindow,
      modelChanges: this.modelChanges,
      formatConflicts: this.formatConflicts,
    };
    this.dirty = false;
    return this.snapshotCache;
  }
}

function parseFile(file) {
  return new IncrementalRolloutParser(file).readAll();
}

// ---------------------------------------------------------------------------
// 命令行输出格式化
//
// 这一层的产物是对外契约：脚本输出的文字会被复制进 issue、日志和文档。
// 重写时结构可以变，但每一条输出必须逐字节一致 —— 由 scripts/golden-baseline.mjs 兜底校验。
// ---------------------------------------------------------------------------

const BLANK_VALUE = "--";

function twoDigits(value) {
  return value < 10 ? "0" + value : "" + value;
}

// ISO 时间 → 本地 "HH:MM"；无法解析时退化为字符串里的时间片段
function clockLabel(iso) {
  if (!iso) return "";
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) return iso.slice(11, 16);
  return twoDigits(moment.getHours()) + ":" + twoDigits(moment.getMinutes());
}

function groupedInteger(value) {
  if (value == null || !Number.isFinite(value)) return BLANK_VALUE;
  return value.toLocaleString("en-US");
}

// 单位表按阈值从大到小排列，命中即返回，避免重复的 if 链
const COMPACT_SCALES = [
  { from: 1e9, divide: 1e9, unit: "B", digits: 2 },
  { from: 1e6, divide: 1e6, unit: "M", digits: 2 },
  { from: 1e3, divide: 1e3, unit: "k", digits: 1 },
];

function compactNumber(value) {
  if (value == null || !Number.isFinite(value)) return BLANK_VALUE;
  for (const scale of COMPACT_SCALES) {
    if (value >= scale.from) return (value / scale.divide).toFixed(scale.digits) + scale.unit;
  }
  return String(Math.round(value));
}

function printStats(stats, { detail = false } = {}) {
  const lines = [];

  lines.push("会话: " + (stats.threadId || "?"));
  lines.push("文件: " + stats.file);
  if (stats.modelContextWindow) lines.push("上下文窗口: " + groupedInteger(stats.modelContextWindow) + " tokens");
  lines.push("请求次数: " + groupedInteger(stats.requestCount));

  let sessionLine =
    "会话累计消耗: " + groupedInteger(stats.sessionTotal) + " tokens (" + compactNumber(stats.sessionTotal) + ")";
  if (stats.sessionInput != null) {
    sessionLine += "  输入 " + compactNumber(stats.sessionInput);
    if (stats.sessionCached != null) {
      const uncached = Math.max(0, stats.sessionInput - stats.sessionCached);
      sessionLine +=
        "（缓存命中 " + compactNumber(stats.sessionCached) + "，未命中 " + compactNumber(uncached) + "）";
    }
    sessionLine += " + 输出 " + compactNumber(stats.sessionOutput);
  }
  lines.push(sessionLine);

  lines.push("");
  lines.push("每轮对话消耗:");

  stats.turns.forEach((turn, turnIndex) => {
    const requests = turn.requestCount != null ? turn.requestCount : turn.requests.length;
    lines.push(
      "  T" + (turnIndex + 1) + "  " + (turn.startLabel || "??:??") + "  " + compactNumber(turn.total) +
        " tokens (输入 " + compactNumber(turn.input) + " + 输出 " + compactNumber(turn.output) + "), " +
        requests + " 次请求",
    );
    if (!detail) return;
    turn.requests.forEach((request, requestIndex) => {
      lines.push(
        "      #" + (requestIndex + 1) + " " + (request.ts || "").slice(11, 19) +
          "  in " + compactNumber(request.input) +
          "  out " + compactNumber(request.output) +
          "  total " + compactNumber(request.lastTotal),
      );
    });
  });

  // 一次写出：与逐行 console.log 的字节输出完全等价（每行都以换行结束）
  console.log(lines.join("\n"));
}

const MAX_REQUEST_DETAILS = 100;

function requestPayloadFor(request, index) {
  const input = request.input != null ? request.input : null;
  const cached = request.cached != null ? request.cached : null;
  return {
    index: index + 1,
    time: clockLabel(request.ts),
    input,
    cached,
    uncached: input != null && cached != null ? Math.max(0, input - cached) : null,
    output: request.output != null ? request.output : null,
    total: request.lastTotal != null ? request.lastTotal : null,
  };
}

function orderedByTimestamp(items) {
  const ordered = [...items];
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i - 1].ts > ordered[i].ts) {
      ordered.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      break;
    }
  }
  return ordered;
}

function createCumulativeCounters() {
  return {
    input: { last: null, base: 0 },
    output: { last: null, base: 0 },
    cached: { last: null, base: 0 },
    total: { last: null, base: 0 },
    resetEvents: 0,
  };
}

function normalizeCumulativeUsage(usage = {}, counters) {
  let sawReset = false;
  const normalized = {};
  for (const key of ["input", "output", "cached", "total"]) {
    const value = Number.isFinite(usage[key]) ? usage[key] : null;
    const counter = counters[key];
    if (value != null && counter.last != null && value < counter.last) {
      counter.base += counter.last;
      sawReset = true;
    }
    if (value != null) counter.last = value;
    normalized[key] = value != null ? counter.base + value : null;
  }
  if (sawReset) counters.resetEvents += 1;
  return normalized;
}

function mergeUsage(previous, next) {
  const merged = { ...(previous || {}) };
  for (const key of ["input", "output", "cached", "total"]) {
    if (next && next[key] != null) merged[key] = next[key];
  }
  return merged;
}

// 统一入口：A（token_count）与 B（token_usage_record）合并统计，见 docs/F1-merge-spec.md。
function buildStats(parsed, options = {}) {
  return buildStatsUnified(parsed, options);
}

function createUnifiedRecordKey(record) {
  return record.responseId || (String(record.ts) + "|" + String(record.total) + "|" + String(record.turnId || ""));
}

// 跨格式身份 = 内容恒等：key = 线程累计 | 本轮量（与参考脚本 lag-methods.cjs / classify.cjs 一致），
// 对应 docs/F1-merge-spec.md 的 R3。两者缺一即视为"无 key"，不参与一对一认领、按独立请求处理。
function contentKeyOf(record) {
  const thread = record.threadUsage ? record.threadUsage.total : null;
  const last = record.requestTotal != null ? record.requestTotal : null;
  if (!Number.isFinite(thread) || !Number.isFinite(last)) return null;
  return String(thread) + "|" + String(last);
}

// 时间轴排序：同一时间戳时 legacy 在前、新格式在后。
function compareByTimestamp(a, b) {
  if (a.ts === b.ts) {
    if (a.source === b.source) return 0;
    return a.source === "legacy" ? -1 : 1;
  }
  return a.ts < b.ts ? -1 : 1;
}

function collectUnifiedRecords(parsed) {
  const legacyRecords = [];
  const seenCounts = new Set();
  for (const count of parsed.counts || []) {
    const key = String(count.ts) + "|" + String(count.total) + "|" + String(count.lastTotal);
    if (seenCounts.has(key)) continue;
    seenCounts.add(key);
    legacyRecords.push({
      source: "legacy",
      ts: count.ts || "",
      turnId: "",
      responseId: "",
      input: count.input,
      output: count.output,
      cached: count.cached,
      requestTotal: count.lastTotal,
      threadUsage: {
        input: count.totalInfo ? count.totalInfo.input : null,
        cached: count.totalInfo ? count.totalInfo.cached : null,
        output: count.totalInfo ? count.totalInfo.output : null,
        total: count.total,
      },
      turnUsage: null,
      model: null,
    });
  }

  const newRecords = [];
  const seenRecords = new Set();
  for (const record of parsed.usageRecords || []) {
    const key = createUnifiedRecordKey(record);
    if (seenRecords.has(key)) continue;
    seenRecords.add(key);
    newRecords.push({
      source: "record",
      ts: record.ts || "",
      turnId: record.turnId || "",
      responseId: record.responseId || "",
      input: record.input,
      output: record.output,
      cached: record.cached,
      requestTotal: record.total,
      threadUsage: record.threadUsage || null,
      turnUsage: record.turnUsage || null,
      model: record.model || null,
    });
  }

  const records = [...legacyRecords, ...newRecords];
  records.sort(compareByTimestamp);

  // 第一遍：新格式自身去重（response_id 优先，其次内容 key）＋真冲突判定。
  // 真冲突（非 0 即报警）：同 response_id 但数值不同，或同 ts 但数值不同。
  const keptModern = [];
  const seenResponseIds = new Map();
  const seenTsKeys = new Map();
  const seenModernKeys = new Set();
  // 解析阶段的真冲突（同 response_id 但数值不同）由 IncrementalRolloutParser 统计后带进来。
  let formatConflictCount = Number.isFinite(parsed.formatConflicts) ? parsed.formatConflicts : 0;
  for (const record of records) {
    const key = contentKeyOf(record);
    if (key != null) {
      const sameStamp = seenTsKeys.get(record.ts);
      if (sameStamp == null) seenTsKeys.set(record.ts, key);
      else if (sameStamp !== key) formatConflictCount += 1;
    }
    if (record.source !== "record") continue;
    if (record.responseId) {
      if (seenResponseIds.has(record.responseId)) {
        const firstKey = seenResponseIds.get(record.responseId);
        if (key != null && firstKey != null && key !== firstKey) formatConflictCount += 1;
        continue;
      }
      seenResponseIds.set(record.responseId, key);
    }
    if (key == null) {
      keptModern.push(record);
      continue;
    }
    if (seenModernKeys.has(key)) continue;
    seenModernKeys.add(key);
    keptModern.push(record);
  }

  // 第二遍：legacy 一对一认领 → echo / replay / unique。
  //   echo   ：同内容 key 且尚未被认领的新格式本体存在 → 认领它（本体只能被认领一次），计入 echoStats；
  //   replay ：同 key 的本体存在但都已被更早的 legacy 认领 → 计入 replayStats（不计入 echoStats、不算请求）；
  //   unique ：新格式里没有该 key → 作为独立请求计入（同 key 再次出现视为自身重复，不重复计）。
  // 时间不参与身份判定，只用于在两具以上本体中挑最近的一具、以及统计滞后。
  const modernByKey = new Map();
  for (const record of keptModern) {
    const recordKey = contentKeyOf(record);
    if (recordKey == null) continue;
    if (!modernByKey.has(recordKey)) modernByKey.set(recordKey, []);
    modernByKey.get(recordKey).push(record);
  }
  const modernKeys = new Set(modernByKey.keys());

  const echoStats = {
    total: 0,
    lagMaxMs: 0,
    overThreshold: 0,
    thresholdMs: ECHO_LAG_THRESHOLD_MS,
    topLag: [],
  };
  const replayStats = { count: 0, lagMaxMs: 0 };
  const uniqueStats = { count: 0, selfDuplicate: 0 };
  const legacyStats = { raw: legacyRecords.length, deduped: 0, claimedModern: 0 };
  const claimedModern = new Set();
  const claimedUniqueKeys = new Set();
  const timeGapMs = (a, b) => Math.abs(Date.parse(a.ts) - Date.parse(b.ts));
  const nearestBody = (list, ms) => {
    let best = null;
    for (const item of list) {
      const distance = Math.abs(Date.parse(item.ts) - ms);
      if (best == null || distance < best.distance) best = { item, distance };
    }
    return best;
  };

  const uniqueRecords = [];
  const legacyInTimeOrder = [...legacyRecords].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const record of legacyInTimeOrder) {
    const key = contentKeyOf(record);
    const candidates = key == null
      ? []
      : (modernByKey.get(key) || []).filter((body) => !claimedModern.has(body));
    if (candidates.length) {
      const hit = nearestBody(candidates, Date.parse(record.ts));
      claimedModern.add(hit.item);
      legacyStats.claimedModern = claimedModern.size;
      echoStats.total += 1;
      const gap = timeGapMs(record, hit.item);
      if (Number.isFinite(gap)) {
        if (gap > echoStats.lagMaxMs) echoStats.lagMaxMs = gap;
        if (gap > ECHO_LAG_THRESHOLD_MS) {
          echoStats.overThreshold += 1;
          echoStats.topLag.push({ ts: record.ts, lagMs: gap });
          echoStats.topLag.sort((a, b) => b.lagMs - a.lagMs);
          if (echoStats.topLag.length > 3) echoStats.topLag.length = 3;
        }
      }
      continue;
    }
    if (key != null && modernKeys.has(key)) {
      replayStats.count += 1;
      const body = nearestBody(modernByKey.get(key), Date.parse(record.ts));
      if (body) {
        const gap = timeGapMs(record, body.item);
        if (Number.isFinite(gap) && gap > replayStats.lagMaxMs) replayStats.lagMaxMs = gap;
      }
      continue;
    }
    if (key != null) {
      if (claimedUniqueKeys.has(key)) {
        uniqueStats.selfDuplicate += 1;
        continue;
      }
      claimedUniqueKeys.add(key);
    }
    uniqueStats.count += 1;
    uniqueRecords.push(record);
  }
  // 结构不变量：echo + replay + unique = legacy 去重后总数。
  legacyStats.deduped = echoStats.total + replayStats.count + uniqueStats.count;

  const merged = [...keptModern, ...uniqueRecords];
  merged.sort(compareByTimestamp);

  return { records: merged, formatConflictCount, echoStats, replayStats, uniqueStats, legacyStats };
}

function buildStatsUnified(parsed, { retainRequests = true } = {}) {
  const collected = collectUnifiedRecords(parsed);
  const records = collected.records;
  const starts = orderedByTimestamp(parsed.userMessages || []);
  const turns = [];
  const turnIndexById = new Map();
  const turnCounters = new Map();
  const threadCounters = createCumulativeCounters();
  let startIndex = 0;
  let retainedTurnIndex = -1;
  let latestThreadUsage = null;
  let latestContextUsed = null;

  const createTurn = (start, fallbackTs) => {
    const startValue = start || fallbackTs || "";
    turns.push({
      start: startValue,
      startLabel: clockLabel(startValue),
      requests: [],
      requestCount: 0,
      input: 0,
      output: 0,
      cached: 0,
      cacheAvailable: true,
      total: 0,
      cumulative: false,
    });
    return turns.length - 1;
  };

  const resolveTurnIndex = (record) => {
    if (record.turnId) {
      if (!turnIndexById.has(record.turnId)) turnIndexById.set(record.turnId, createTurn("", record.ts));
      return turnIndexById.get(record.turnId);
    }
    while (startIndex + 1 < starts.length && starts[startIndex + 1].ts <= record.ts) startIndex += 1;
    const index = starts.length ? startIndex : Math.max(0, turns.length - 1);
    while (turns.length <= index) {
      const start = starts[turns.length] ? starts[turns.length].ts : "";
      createTurn(start, record.ts);
    }
    return index;
  };

  for (const record of records) {
    const turnIndex = resolveTurnIndex(record);
    const turn = turns[turnIndex];
    const turnKey = record.turnId || ("boundary:" + String(turnIndex));
    if (!turnCounters.has(turnKey)) turnCounters.set(turnKey, createCumulativeCounters());

    const normalizedThreadUsage = normalizeCumulativeUsage(record.threadUsage || {}, threadCounters);
    const normalizedTurnUsage = record.turnUsage
      ? normalizeCumulativeUsage(record.turnUsage, turnCounters.get(turnKey))
      : {};
    latestThreadUsage = mergeUsage(latestThreadUsage, normalizedThreadUsage);
    if (Number.isFinite(record.requestTotal)) latestContextUsed = record.requestTotal;

    const request = {
      ts: record.ts,
      input: record.input != null ? record.input : null,
      output: record.output != null ? record.output : null,
      cached: record.cached != null ? record.cached : null,
      lastTotal: record.requestTotal != null ? record.requestTotal : null,
      totalInfo: normalizedThreadUsage,
      model: record.model || null,
    };
    if (retainRequests) {
      turn.requests.push(request);
    } else {
      if (retainedTurnIndex !== turnIndex) {
        if (retainedTurnIndex >= 0) turns[retainedTurnIndex].requests = [];
        retainedTurnIndex = turnIndex;
      }
      turn.requests.push(request);
      if (turn.requests.length > MAX_REQUEST_DETAILS) turn.requests.shift();
    }
    turn.requestCount += 1;

    if (Object.values(normalizedTurnUsage).some((value) => value != null)) turn.cumulative = true;
    if (turn.cumulative) {
      if (normalizedTurnUsage.input != null) turn.input = normalizedTurnUsage.input;
      if (normalizedTurnUsage.output != null) turn.output = normalizedTurnUsage.output;
      if (normalizedTurnUsage.cached != null) turn.cached = normalizedTurnUsage.cached;
      if (normalizedTurnUsage.total != null) turn.total = normalizedTurnUsage.total;
    } else {
      if (record.input != null) turn.input += record.input;
      if (record.output != null) turn.output += record.output;
      if (record.cached != null) turn.cached += record.cached;
      else turn.cacheAvailable = false;
      if (record.requestTotal != null) turn.total += record.requestTotal;
    }
  }

  const threadUsage = latestThreadUsage || {};
  const cumulativeResetCount = threadCounters.resetEvents +
    [...turnCounters.values()].reduce((sum, counters) => sum + counters.resetEvents, 0);

  return {
    threadId: parsed.threadId,
    file: parsed.file,
    date: parsed.date,
    modelContextWindow: parsed.modelContextWindow,
    requestCount: records.length,
    sessionTotal: threadUsage.total != null ? threadUsage.total : null,
    sessionInput: threadUsage.input != null ? threadUsage.input : null,
    sessionCached: threadUsage.cached != null ? threadUsage.cached : null,
    sessionOutput: threadUsage.output != null ? threadUsage.output : null,
    modelSwitchCount: Math.max(0, (parsed.modelChanges || []).length - 1),
    cumulativeResetCount,
    formatConflictCount: collected.formatConflictCount,
    echoStats: collected.echoStats,
    replayStats: collected.replayStats,
    uniqueStats: collected.uniqueStats,
    legacyStats: collected.legacyStats,
    contextUsed:
      latestContextUsed != null
        ? parsed.modelContextWindow != null
          ? Math.min(latestContextUsed, parsed.modelContextWindow)
          : latestContextUsed
        : null,
    turns: turns.map((turn) => ({
      start: turn.start,
      startLabel: turn.startLabel,
      requests: turn.requests,
      requestCount: turn.requestCount,
      input: turn.input,
      output: turn.output,
      cached: turn.cacheAvailable ? turn.cached : null,
      total: turn.total,
    })),
  };
}
function turnPayloadFor(turn, index) {
  return {
    index: index + 1,
    startLabel: turn.startLabel,
    requests: turn.requestCount != null ? turn.requestCount : turn.requests.length,
    input: turn.input,
    cached: turn.cached,
    uncached: turn.input != null && turn.cached != null ? Math.max(0, turn.input - turn.cached) : null,
    output: turn.output,
    total: turn.total,
  };
}

function payloadFor(stats, health = makeHealth({ status: "healthy", dataFresh: true })) {
  const currentTurn = stats.turns.length ? stats.turns[stats.turns.length - 1] : null;
  const currentRequests = currentTurn ? currentTurn.requests : [];
  const currentRequestTotal = currentTurn
    ? currentTurn.requestCount != null
      ? currentTurn.requestCount
      : currentRequests.length
    : 0;
  const requestSliceStart = Math.max(0, currentRequests.length - MAX_REQUEST_DETAILS);
  const requestIndexStart = Math.max(0, currentRequestTotal - currentRequests.length) + requestSliceStart;
  const turnStart = Math.max(0, stats.turns.length - MAX_TURN_SUMMARIES);
  return {
    protocolName: PROTOCOL_NAME,
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    capabilities: PROTOCOL_CAPABILITIES,
    modelContextWindow: stats.modelContextWindow,
    requestCount: stats.requestCount,
    sessionTotal: stats.sessionTotal,
    sessionInput: stats.sessionInput,
    sessionCached: stats.sessionCached,
    sessionOutput: stats.sessionOutput,
    contextUsed: stats.contextUsed,
    turnTotal: currentTurn ? currentTurn.total : 0,
    turnInput: currentTurn ? currentTurn.input : 0,
    turnCached: currentTurn ? currentTurn.cached : 0,
    turnOutput: currentTurn ? currentTurn.output : 0,
    currentTurnIndex: currentTurn ? stats.turns.length : 0,
    turns: stats.turns.slice(turnStart).map((turn, index) =>
      turnPayloadFor(turn, turnStart + index),
    ),
    turnsTruncated: turnStart > 0,
    turnTotalCount: stats.turns.length,
    requestDetails: currentRequests.slice(requestSliceStart).map((request, index) =>
      requestPayloadFor(request, requestIndexStart + index),
    ),
    requestDetailsTruncated: requestSliceStart > 0 || currentRequestTotal > currentRequests.length,
    requestDetailTotal: currentRequestTotal,
    modelSwitchCount: stats.modelSwitchCount || 0,
    cumulativeResetCount: stats.cumulativeResetCount || 0,
    health: normalizeHealth(health),
    updatedAt: new Date().toISOString(),
  };
  const validation = validatePayload(payload, { allowLegacy: false });
  if (!validation.ok) {
    const error = new Error("payload validation failed: " + validation.errors.join("; "));
    error.code = "PAYLOAD_INVALID";
    throw error;
  }
  return payload;
}

let cdpConnection = null;
let cdpConnectPromise = null;
let cdpNextMessageId = 1;

class CdpTargetError extends Error {
  constructor(code, message, targetCount = 0) {
    super(message);
    this.name = "CdpTargetError";
    this.code = code;
    this.targetCount = targetCount;
  }
}

function shouldPropagateCdpTargetError(error) {
  return !!(error && [
    "CDP_TARGET_SELECTION_REQUIRED",
    "CDP_TARGET_NOT_FOUND",
    "CDP_PAGE_NOT_FOUND",
    "CDP_UNREACHABLE",
    "CDP_PROTOCOL_MISMATCH",
  ].includes(error.code));
}

function isSafeCdpTarget(target) {
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) return false;
  const url = String(target.url || "");
  if (url.includes("avatar-overlay")) return false;
  if (url !== "app://-/index.html" && !url.startsWith("app://-/")) return false;
  try {
    const ws = new URL(target.webSocketDebuggerUrl);
    if (ws.protocol !== "ws:" || ws.hostname !== "127.0.0.1") return false;
  } catch {
    return false;
  }
  return true;
}

function probeCdpTarget(target) {
  return new Promise((resolve) => {
    let ws;
    let settled = false;
    const timer = setTimeout(() => finish({ focused: false, visible: false, probeFailed: true }), 1500);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ ...target, ...result });
    };
    try {
      ws = new WebSocket(target.webSocketDebuggerUrl);
    } catch {
      finish({ focused: false, visible: false, probeFailed: true });
      return;
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: "JSON.stringify({focused:document.hasFocus(),visible:document.visibilityState === 'visible',hasPanel:!!window.__ccmTokenSpendNativeUiInstalled})",
          returnByValue: true,
        },
      }));
    };
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        const value = message.result && message.result.result ? message.result.result.value : null;
        const result = value ? JSON.parse(value) : {};
        finish({ focused: result.focused === true, visible: result.visible === true, hasPanel: result.hasPanel === true });
      } catch {
        clearTimeout(timer);
        finish({ focused: false, visible: false, probeFailed: true });
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      finish({ focused: false, visible: false, probeFailed: true });
    };
  });
}

async function findCdpPages(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  let targets;
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/json", { signal: controller.signal });
    if (!response.ok) {
      const error = new CdpTargetError("CDP_UNREACHABLE", "CDP HTTP " + response.status);
      throw error;
    }
    targets = await response.json();
  } catch (error) {
    if (error && error.code === "CDP_UNREACHABLE") throw error;
    const wrapped = new CdpTargetError("CDP_UNREACHABLE", "无法连接 Codex CDP 端口 " + port);
    wrapped.cause = error;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
  const eligible = Array.isArray(targets) ? targets.filter(isSafeCdpTarget) : [];
  if (!eligible.length) throw new CdpTargetError("CDP_PAGE_NOT_FOUND", "Codex page target not found on CDP port " + port);
  return eligible;
}

async function findCdpPage(port, targetSelector = DEFAULT_TARGET_SELECTOR) {
  const pages = await findCdpPages(port);
  if (targetSelector && targetSelector !== "auto" && targetSelector !== "focused") {
    const page = pages.find((target) => target.id === targetSelector);
    if (!page) throw new CdpTargetError("CDP_TARGET_NOT_FOUND", "Requested Codex target was not found", pages.length);
    return { ...page, targetCount: pages.length, targetSelection: "manual" };
  }
  if (pages.length === 1) return { ...pages[0], targetCount: 1, targetSelection: "single" };
  const probed = await Promise.all(pages.map(probeCdpTarget));
  const focused = probed.filter((page) => page.focused);
  if (focused.length === 1) return { ...focused[0], targetCount: pages.length, targetSelection: "focused" };
  const visible = probed.filter((page) => page.visible);
  if (visible.length === 1) return { ...visible[0], targetCount: pages.length, targetSelection: "visible" };
  throw new CdpTargetError(
    "CDP_TARGET_SELECTION_REQUIRED",
    "Multiple Codex windows detected; use --target <target-id> or focus one Codex window",
    pages.length,
  );
}

function rejectCdpPending(connection, error) {
  for (const [id, pending] of connection.pending) {
    clearTimeout(pending.timer);
    connection.pending.delete(id);
    pending.reject(error);
  }
}

function closeCdpConnection(reason = "CDP connection closed") {
  const connection = cdpConnection;
  cdpConnection = null;
  if (!connection) return;
  rejectCdpPending(connection, new Error(reason));
  try { connection.ws.close(); } catch {}
}

async function ensureCdpConnection(port, targetSelector = DEFAULT_TARGET_SELECTOR) {
  if (cdpConnection && cdpConnection.port === port && cdpConnection.targetSelector === targetSelector && cdpConnection.ws.readyState === 1) return cdpConnection;
  if (cdpConnectPromise) return cdpConnectPromise;

  cdpConnectPromise = (async () => {
    const page = await findCdpPage(port, targetSelector);
    if (cdpConnection) closeCdpConnection("CDP target changed");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const connection = {
      port,
      url: page.webSocketDebuggerUrl,
      targetId: page.id,
      targetSelector,
      targetCount: page.targetCount,
      targetSelection: page.targetSelection,
      ws,
      pending: new Map(),
      pageChanged: true,
    };
    cdpConnection = connection;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.method === "Page.frameNavigated" || msg.method === "Page.frameStartedLoading" || msg.method === "Page.loadEventFired") {
        connection.pageChanged = true;
        return;
      }
      const pending = connection.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      connection.pending.delete(msg.id);
      if (msg.result && msg.result.exceptionDetails) {
        pending.reject(new Error("page error: " + JSON.stringify(msg.result.exceptionDetails).slice(0, 200)));
      } else {
        pending.resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
      }
    };
    ws.onclose = () => {
      if (cdpConnection === connection) cdpConnection = null;
      rejectCdpPending(connection, new Error("CDP WebSocket closed"));
    };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connect timeout on port " + port)), 8000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error("WebSocket error: " + (e && e.message ? e.message : "unknown")));
      };
    });
    try { ws.send(JSON.stringify({ id: 0, method: "Page.enable" })); } catch {}
    return connection;
  })().finally(() => {
    cdpConnectPromise = null;
  });

  try {
    return await cdpConnectPromise;
  } catch (error) {
    if (cdpConnection && cdpConnection.ws.readyState !== 1) closeCdpConnection("CDP connection failed");
    throw error;
  }
}

function assertSafeCdpExpression(expression) {
  if (typeof expression !== "string" || (!expression.startsWith("(function ()") && !expression.startsWith("JSON.stringify(") && !expression.startsWith("!!document.querySelector(") && !expression.startsWith("window.__ccmTokenSpend ="))) {
    const error = new Error("Blocked non-whitelisted CDP expression");
    error.code = "CDP_EXPRESSION_BLOCKED";
    throw error;
  }
}

async function cdpEval(port, expression, targetSelector = currentTargetSelector) {
  assertSafeCdpExpression(expression);
  const connection = await ensureCdpConnection(port, targetSelector);
  return new Promise((resolve, reject) => {
    const id = cdpNextMessageId++;
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      closeCdpConnection("CDP timeout on port " + port);
      reject(new Error("CDP timeout on port " + port));
    }, 8000);
    connection.pending.set(id, { resolve, reject, timer });
    try {
      connection.ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    } catch (error) {
      clearTimeout(timer);
      connection.pending.delete(id);
      closeCdpConnection("CDP send failed");
      reject(error);
    }
  });
}

// A2: 内置会话 ID 检测，完全自研，不依赖任何外部脚本。
// 从页面 DOM / React fiber 读取当前会话 ID；侧边栏收起时沿用最后确认的 ID。
// 逻辑参考开源实现（MIT）的 readActiveConversationId。
// Sentinel returned when the user is on a brand-new blank conversation that has
// no messages yet: the panel should show zeros instead of the previous data.
const NEW_THREAD = "__new_blank__";
let activeThreadProbe = { port: 0, id: null, checkedAt: 0, connectionUrl: "" };

async function activeThreadId(port, targetSelector = DEFAULT_TARGET_SELECTOR) {
 const probeNow = Date.now();
 const connectionUrl = cdpConnection && cdpConnection.port === port ? cdpConnection.url : "";
  if (activeThreadProbe.port === port && activeThreadProbe.targetSelector === targetSelector && activeThreadProbe.connectionUrl === connectionUrl && probeNow - activeThreadProbe.checkedAt < THREAD_PROBE_INTERVAL_MS && !(cdpConnection && cdpConnection.pageChanged)) {
   return activeThreadProbe.id;
 }
 try {
   const id = await cdpEval(
     port,
      `(function () {
        var BLANK_CONVERSATION = "${NEW_THREAD}";
        var UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        var CLIENT_NEW_THREAD_PATTERN = /client-new-thread:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
        var THREAD_ID_ATTRS = ["data-app-action-sidebar-thread-id", "data-thread-id", "data-conversation-id"];
        var THREAD_STATE_ATTRS = ["aria-current", "aria-selected", "data-app-action-sidebar-thread-active"].concat(THREAD_ID_ATTRS);
        var ACTIVE_THREAD_SELECTORS = [
          '[aria-current="page"][data-app-action-sidebar-thread-id]',
          '[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]',
          '[aria-selected="true"][data-app-action-sidebar-thread-id]'
        ];
        var CONVERSATION_SELECTORS = [
          '[data-thread-find-target="conversation"]',
          '[data-thread-find-composer="true"]',
          '[data-codex-composer="true"]',
          '[data-app-shell-main-content-layout*="thread"]'
        ];
        var MARKER_SELECTOR = ACTIVE_THREAD_SELECTORS
          .concat(THREAD_ID_ATTRS.map(function (attr) { return "[" + attr + "]"; }))
          .concat(["[data-thread-find-target]", "[data-thread-find-composer]", "[data-codex-composer]"])
          .join(",");
        var FALLBACK_ACTIVE_SELECTORS = ACTIVE_THREAD_SELECTORS.concat([
          '[aria-current="page"]',
          '[data-app-action-sidebar-thread-active="true"]',
          '[aria-selected="true"]'
        ]);
        var SCAN_ID_KEYS = ["conversationId", "localConversationId", "threadId", "id", "key"];
        var SCAN_PROP_PATTERN = /^(?:props|children|memoizedProps|pendingProps|memoizedState|stateNode|child|sibling|return|alternate|value|current|context|node|chain|conversationId|localConversationId|threadId|id|key|params|thread|conversation)$/;
        var SCAN_BRANCH_LIMIT = 40;
        var SCAN_MAX_DEPTH = 14;

        function firstQuery(selectors) {
          for (var i = 0; i < selectors.length; i++) {
            var found = document.querySelector(selectors[i]);
            if (found) return found;
          }
          return null;
        }

        // 把页面上的各种 ID 形态归一化：client-new-thread 占位 ID、裸 UUID、带 scheme 前缀的值。
        function normalizeThreadId(value) {
          if (value == null) return null;
          if (typeof value !== "string" && typeof value !== "number") return null;
          var text = String(value).trim();
          if (!text) return null;
          var placeholder = CLIENT_NEW_THREAD_PATTERN.exec(text);
          if (placeholder) return "client-new-thread:" + placeholder[1].toLowerCase();
          var uuid = UUID_PATTERN.exec(text);
          if (uuid) return uuid[0].toLowerCase();
          return text.replace(/^[a-z]+:/i, "").toLowerCase();
        }

        // 从元素自身向上找最近的线程标记属性
        function threadIdFromElement(element) {
          if (!element || element.nodeType !== 1) return null;
          for (var node = element; node && node.nodeType === 1; node = node.parentElement) {
            for (var i = 0; i < THREAD_ID_ATTRS.length; i++) {
              var normalized = normalizeThreadId(node.getAttribute(THREAD_ID_ATTRS[i]));
              if (normalized) return normalized;
            }
          }
          return null;
        }

        // 主会话区是否已经存在（空白新对话还没有）
        function hasConversationSurface() {
          for (var i = 0; i < CONVERSATION_SELECTORS.length; i++) {
            if (document.querySelector(CONVERSATION_SELECTORS[i])) return true;
          }
          return false;
        }

        function rememberActiveThread(id) {
          window.__ccmTokenSpendActiveId = { id: id, at: Date.now() };
          return id;
        }

        function touchesThreadMarker(node) {
          if (!node || node.nodeType !== 1) return false;
          try {
            return node.matches(MARKER_SELECTOR) || !!node.querySelector(MARKER_SELECTOR);
          } catch (e) {
            return false;
          }
        }

        // DOM 变化时只更新一个版本号并作废缓存；真正的解析留给下次查询。
        if (!window.__ccmTokenSpendThreadObserverInstalled && document.documentElement && typeof MutationObserver === "function") {
          var observer = new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
              var record = records[i];
              var relevant = record.type === "attributes";
              if (!relevant && record.type === "childList") {
                var changed = [].slice.call(record.addedNodes).concat([].slice.call(record.removedNodes));
                relevant = changed.some(touchesThreadMarker);
              }
              if (relevant) {
                window.__ccmTokenSpendDomVersion = (window.__ccmTokenSpendDomVersion || 0) + 1;
                window.__ccmTokenSpendActiveIdCache = null;
                return;
              }
            }
          });
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: THREAD_STATE_ATTRS,
          });
          window.__ccmTokenSpendThreadObserverInstalled = true;
          window.__ccmTokenSpendDomVersion = window.__ccmTokenSpendDomVersion || 0;
        }

        var activeSels = FALLBACK_ACTIVE_SELECTORS;
        // 空白新对话：侧边栏没有 active 线程、主会话区也还没建立。
        // 这时返回哨兵值，让面板显示 0，而不是沿用上一个对话的数据。
        // 注意：只有带线程标记的侧边栏项才算 active —— 文件夹等元素也会带 aria-current="page"。
        try {
          var activeThreadNow = firstQuery(ACTIVE_THREAD_SELECTORS);
          if (!activeThreadNow && !document.querySelector('main [data-thread-find-target="conversation"]') && hasConversationSurface()) {
            return BLANK_CONVERSATION;
          }
        } catch (e) {}
        try {
          for (var i = 0; i < activeSels.length; i++) {
            var fromActive = threadIdFromElement(document.querySelector(activeSels[i]));
            if (fromActive) return rememberActiveThread(fromActive);
          }
        } catch (e) {}
        try {
          // React fiber 兜底扫描较慢，缓存有效期内不重复扫描。
          var now = Date.now();
          var cache = window.__ccmTokenSpendActiveIdCache;
          if (cache && cache.id && now - cache.at < ${ACTIVE_ID_CACHE_MS}) {
            // 主会话区必须仍然存在，否则缓存已失效（用户切到了空白新对话）。
            if (document.querySelector('main [data-thread-find-target="conversation"]')) return cache.id;
          }
          var seen = new WeakSet();
          function scan(value, depth) {
            if (!value || typeof value !== "object" || depth < 0) return null;
            if (seen.has(value)) return null;
            seen.add(value);
            for (var k = 0; k < SCAN_ID_KEYS.length; k++) {
              try {
                var named = normalizeThreadId(value[SCAN_ID_KEYS[k]]);
                if (named && /[0-9a-f]{8}-/.test(named)) return named;
              } catch (e) {}
            }
            if (value.nodeType === 1) {
              var fromNode = threadIdFromElement(value);
              if (fromNode) return fromNode;
            }
            if (Array.isArray(value)) {
              var arrayLimit = Math.min(value.length, SCAN_BRANCH_LIMIT);
              for (var arrayIndex = 0; arrayIndex < arrayLimit; arrayIndex++) {
                var fromArray = scan(value[arrayIndex], depth - 1);
                if (fromArray) return fromArray;
              }
              return null;
            }
            if (value instanceof Map) {
              var mapSeen = 0;
              for (var entry of value) {
                if (mapSeen >= SCAN_BRANCH_LIMIT) break;
                var fromMap = scan(entry[1], depth - 1);
                if (fromMap) return fromMap;
                mapSeen += 1;
              }
              return null;
            }
            for (var key in value) {
              if (!SCAN_PROP_PATTERN.test(key)) continue;
              try {
                var child = value[key];
                if (child === value) continue;
                var fromChild = scan(child, depth - 1);
                if (fromChild) return fromChild;
              } catch (e) {}
            }
            return null;
          }
          var anchors = [
            document.querySelector("main"),
            document.querySelector('[data-thread-find-target="conversation"]'),
            document.querySelector('[data-thread-find-composer="true"]'),
            document.querySelector('[data-codex-composer="true"]'),
            document.getElementById("root")
          ];
          for (var a = 0; a < anchors.length; a++) {
            var anchor = anchors[a];
            if (!anchor) continue;
            var direct = threadIdFromElement(anchor);
            if (direct) { window.__ccmTokenSpendActiveIdCache = { id: direct, at: now }; return rememberActiveThread(direct); }
            for (var reactKey in anchor) {
              if (!/^__react(?:Props|Fiber|Container)\$/.test(reactKey)) continue;
              try {
                var scanned = scan(anchor[reactKey], SCAN_MAX_DEPTH);
                if (scanned) { window.__ccmTokenSpendActiveIdCache = { id: scanned, at: now }; return rememberActiveThread(scanned); }
              } catch (e) {}
            }
          }
          window.__ccmTokenSpendActiveIdCache = { id: null, at: now };
        } catch (e) {}
        // 侧边栏收起时 active/current 节点会消失；主会话区仍在时沿用最后确认的 ID。
        try {
          var last = window.__ccmTokenSpendActiveId;
          if (last && last.id && document.querySelector('main [data-thread-find-target="conversation"]') && hasConversationSurface()) return last.id;
        } catch (e) {}
        return null;
     })()`,
      targetSelector,
   );
   activeThreadProbe = {
     port,
     id: id || null,
     checkedAt: Date.now(),
     connectionUrl: cdpConnection && cdpConnection.port === port ? cdpConnection.url : connectionUrl,
      targetSelector,
   };
   if (id) return id;
  } catch (error) {
    if (shouldPropagateCdpTargetError(error)) throw error;
  }
   activeThreadProbe = { port, id: null, checkedAt: Date.now(), connectionUrl, targetSelector };
  return null;
}

async function cdpPush(port, payload, serialized = JSON.stringify(payload), targetSelector = DEFAULT_TARGET_SELECTOR) {
  const expr = `(function () {
    var protocol = window.__ccmTokenSpendProtocol;
    if (!window.__ccmTokenSpendNativeUiInstalled) return "page-not-ready";
    if (!protocol || protocol.protocolName !== "${PROTOCOL_NAME}" || !Array.isArray(protocol.supportedSchemaVersions) || protocol.supportedSchemaVersions.indexOf(${PROTOCOL_SCHEMA_VERSION}) < 0) return "protocol-mismatch";
    window.__ccmTokenSpend = ${serialized};
    window.dispatchEvent(new Event("ccm-token-spend"));
    return "ok";
  })()`;
  const result = await cdpEval(port, expr, targetSelector);
  if (result === "protocol-mismatch") {
    const error = new Error("Codex++ UI does not support payload schema v" + PROTOCOL_SCHEMA_VERSION);
    error.code = "CDP_PROTOCOL_MISMATCH";
    throw error;
  }
  if (result === "page-not-ready") {
    const error = new Error("Codex++ Token UI is not loaded in the selected Codex page");
    error.code = "CDP_PAGE_NOT_READY";
    throw error;
  }
  return result;
}

// 指定 thread 时优先走索引（O(1)），索引失效再退化为线性比对
function locateThreadFile(files, threadId) {
  const indexed = rolloutFileIndex.get(threadId);
  if (indexed && files.includes(indexed)) return indexed;
  for (const file of files) {
    if (threadIdOf(file) === threadId) return file;
  }
  return null;
}

// 未指定 thread 时取「最近写入」的那个会话文件
function newestRolloutFile(files) {
  let newest = null;
  let newestMtime = -1;
  for (const file of files) {
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue; // 文件在枚举与 stat 之间被移除，忽略
    }
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newest = file;
    }
  }
  return newest;
}

function resolveFile(threadId) {
  const files = findRolloutFiles();
  return threadId ? locateThreadFile(files, threadId) : newestRolloutFile(files);
}

// Stats for a conversation that exists but has no data yet (shows zeros).
function emptyStats(threadId, file) {
  return {
    threadId: threadId || "",
    file: file || "",
    date: file ? fileDate(file) : "",
    modelContextWindow: null,
    requestCount: 0,
    sessionTotal: 0,
    sessionInput: 0,
    sessionCached: 0,
    sessionOutput: 0,
    contextUsed: 0,
    modelSwitchCount: 0,
    cumulativeResetCount: 0,
    turns: [],
  };
}

function environmentSnapshot() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const platformSupported = process.platform === "win32";
  const nodeSupported = Number.isInteger(nodeMajor) && nodeMajor >= 22;
  const codexPlusPlusInstalled = fs.existsSync(CODEX_PLUS_PLUS_USER_SCRIPTS);
  let autostartInstalled = null;
  try {
    const autostart = JSON.parse(fs.readFileSync(AUTOSTART_STATE_FILE, "utf8"));
    if (autostart && typeof autostart.installed === "boolean") autostartInstalled = autostart.installed;
  } catch {}
  return {
    platform: "windows",
    platformSupported,
    nodeSupported,
    installationState: !platformSupported || !nodeSupported
      ? "invalid"
      : codexPlusPlusInstalled ? "ready" : "missing",
    codexPlusPlusInstalled,
    autostartInstalled,
  };
}

function monitorHealthFor(args, overrides = {}) {
  const environment = environmentSnapshot();
  const targetMode = args && args.target && args.target !== "auto" && args.target !== "focused" ? "manual" : (args && args.target) || "auto";
  return normalizeHealth(makeHealth({
    platform: "windows",
    platformSupported: environment.platformSupported,
    nodeSupported: environment.nodeSupported,
    installationState: environment.installationState,
    autostartInstalled: environment.autostartInstalled,
    targetMode,
    ...overrides,
  }));
}

function healthKeyOf(health) {
  const normalized = normalizeHealth(health);
  return JSON.stringify([
    normalized.status,
    normalized.recoveryState,
    normalized.platformSupported,
    normalized.nodeSupported,
    normalized.cdpReachable,
    normalized.pageAttached,
    normalized.targetMode,
    normalized.targetSelection,
    normalized.targetCount,
    normalized.dataFresh,
    normalized.lastSuccessAt,
    normalized.lastErrorCode,
    normalized.installationState,
  ]);
}

function persistMonitorHealth(health) {
  try {
    const normalized = normalizeHealth(health);
    fs.mkdirSync(LOCAL_STATE_DIR, { recursive: true });
    const tempFile = MONITOR_HEALTH_FILE + "." + process.pid + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(normalized), "utf8");
    try {
      fs.renameSync(tempFile, MONITOR_HEALTH_FILE);
    } catch {
      fs.copyFileSync(tempFile, MONITOR_HEALTH_FILE);
      fs.rmSync(tempFile, { force: true });
    }
  } catch {}
}

// 监控自管日志：append + 按日分文件 + 超限轮转，避免 Start-Process 重定向每次截断。
function monitorLog(message) {
  const line = "[" + new Date().toLocaleString() + "] " + message;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, "watch-" + day + ".log");
    try {
      const stat = fs.statSync(file);
      if (stat.size > LOG_ROTATE_BYTES) fs.renameSync(file, file + "." + Date.now());
    } catch {}
    fs.appendFileSync(file, line + os.EOL, "utf8");
  } catch {}
}

function pruneMonitorLogs() {
  try {
    const entries = fs.readdirSync(LOG_DIR)
      .filter((name) => name.startsWith("watch-") || name.startsWith("monitor-"))
      .map((name) => ({ name, full: path.join(LOG_DIR, name) }))
      .sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const entry of entries.slice(MAX_LOG_FILES)) {
      try { fs.rmSync(entry.full, { force: true }); } catch {}
    }
  } catch {}
}

function healthForError(error, args, previousHealth) {
  const code = error && error.code ? error.code : "MONITOR_ERROR";
  let status = "recovering";
  let recoveryState = "retrying";
  let cdpReachable = previousHealth && previousHealth.cdpReachable === true;
  let pageAttached = previousHealth && previousHealth.pageAttached === true;
  let targetSelection = previousHealth && previousHealth.targetSelection || "unknown";
  let targetCount = previousHealth && Number.isInteger(previousHealth.targetCount) ? previousHealth.targetCount : 0;
  if (code === "CDP_UNREACHABLE") {
    status = "waiting-for-cdp";
    cdpReachable = false;
    pageAttached = false;
    targetSelection = "unknown";
    targetCount = 0;
  } else if (code === "CDP_PAGE_NOT_FOUND" || code === "CDP_PAGE_NOT_READY" || code === "CDP_TARGET_NOT_FOUND") {
    status = "waiting-for-page";
    cdpReachable = true;
    pageAttached = false;
    targetSelection = code === "CDP_TARGET_NOT_FOUND" ? "required" : "unknown";
  } else if (code === "CDP_TARGET_SELECTION_REQUIRED") {
    status = "target-selection-required";
    cdpReachable = true;
    pageAttached = false;
    targetSelection = "required";
    targetCount = Number.isInteger(error.targetCount) ? error.targetCount : targetCount;
  } else if (code === "CDP_PROTOCOL_MISMATCH") {
    status = "protocol-mismatch";
    cdpReachable = true;
    pageAttached = true;
  } else if (code === "PAYLOAD_INVALID") {
    status = "failed";
    recoveryState = "failed";
  }
  return monitorHealthFor(args, {
    status,
    recoveryState,
    cdpReachable,
    pageAttached,
    targetSelection,
    targetCount,
    dataFresh: false,
    lastSuccessAt: previousHealth && previousHealth.lastSuccessAt || null,
    lastErrorCode: code,
    lastErrorAt: new Date().toISOString(),
  });
}

// ---- client-new-thread 占位 ID 映射 ----
// 新建对话在侧边栏里是 local:client-new-thread:<uuid> 占位 ID，而会话文件用的是真实 ID。
// 遇到占位 ID 时，把「占位 ID 首次出现之后新建的会话文件」学习为该对话的真实 ID，
// 并持久化到本地，避免监控进程重启后丢失映射。
const CLIENT_MAP_DIR = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const CLIENT_MAP_FILE = path.join(CLIENT_MAP_DIR, STATE_DIR_NAME, "client-thread-map.json");
const CLIENT_STATE_MAX_ENTRIES = 500;
const CLIENT_STATE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const CLIENT_NEW_THREAD_PREFIX = "client-new-thread:";
const CLIENT_UUID_RE = /^client-new-thread:([0-9a-f-]+)$/i;
// 会话文件创建时间可能比「占位对话被激活」的时刻略早，这里给 1 秒容差
const CLIENT_FILE_CREATE_SLACK_MS = 1000;

// 读取本地映射；文件缺失、损坏或字段类型不对时退回空状态（不影响统计）
function readClientStateFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      clientMap: parsed && typeof parsed.clientMap === "object" ? parsed.clientMap : {},
      activatedAt: parsed && typeof parsed.activatedAt === "object" ? parsed.activatedAt : {},
    };
  } catch {
    return { clientMap: {}, activatedAt: {} };
  }
}

let clientState = readClientStateFile(CLIENT_MAP_FILE);

// 只保留「最近 500 个且不超过 90 天」的占位对话记录，两张表同步裁剪。
function pruneClientState() {
  const now = Date.now();
  const candidates = [];
  for (const [id, rawTime] of Object.entries(clientState.activatedAt)) {
    const activatedAt = Number(rawTime);
    if (!Number.isFinite(activatedAt)) continue;
    if (now - activatedAt > CLIENT_STATE_MAX_AGE_MS) continue;
    candidates.push([id, activatedAt]);
  }
  candidates.sort((a, b) => b[1] - a[1]);
  const keep = new Set(candidates.slice(0, CLIENT_STATE_MAX_ENTRIES).map(([id]) => id));

  const dropStale = (bucket) => {
    for (const id of Object.keys(bucket)) {
      if (!keep.has(id)) delete bucket[id];
    }
  };
  dropStale(clientState.activatedAt);
  dropStale(clientState.clientMap);
}

// 先写临时文件再改名，避免进程被强杀时留下半截 JSON；改名失败退化为覆盖写。
function saveClientState() {
  try {
    pruneClientState();
    fs.mkdirSync(path.dirname(CLIENT_MAP_FILE), { recursive: true });
    const staged = CLIENT_MAP_FILE + "." + process.pid + ".tmp";
    fs.writeFileSync(staged, JSON.stringify(clientState), "utf8");
    try {
      fs.renameSync(staged, CLIENT_MAP_FILE);
    } catch {
      fs.copyFileSync(staged, CLIENT_MAP_FILE);
      fs.rmSync(staged, { force: true });
    }
  } catch {
    // 状态文件写失败只影响映射记忆，下次推送时会再试
  }
}

function isClientNewThread(id) {
  return typeof id === "string" && id.startsWith(CLIENT_NEW_THREAD_PREFIX);
}

function clientThreadUuid(id) {
  const matched = CLIENT_UUID_RE.exec(id);
  return matched ? matched[1] : id;
}

// 占位对话首次出现之后才创建的会话文件，就是它的真实 ID（用创建时间做判据）。
function findNewestClientFileSince(ts, excludeThreadId) {
  const earliestAllowed = ts - CLIENT_FILE_CREATE_SLACK_MS;
  let newest = null;
  let newestMtime = -1;
  for (const file of findRolloutFiles()) {
    if (excludeThreadId && threadIdOf(file) === excludeThreadId) continue;
    let info;
    try {
      info = fs.statSync(file);
    } catch {
      continue;
    }
    const createdAt = info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs;
    if (createdAt < earliestAllowed) continue;
    if (info.mtimeMs > newestMtime) {
      newestMtime = info.mtimeMs;
      newest = file;
    }
  }
  return newest ? threadIdOf(newest) : null;
}

// 兜底：文件创建时间早于激活时间（老版本遗留的占位对话），
// 改用「最新且尚未被其它占位对话认领」的会话文件。
function findNewestUnclaimedFile(excludeThreadId, claimedSet) {
  let newest = null;
  let newestMtime = -1;
  for (const file of findRolloutFiles()) {
    const id = threadIdOf(file);
    if (!id) continue;
    if (excludeThreadId && id === excludeThreadId) continue;
    if (claimedSet && claimedSet.has(id)) continue;
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newest = file;
    }
  }
  return newest ? threadIdOf(newest) : null;
}

// 页面里是否有真实会话内容（空白新对话没有 conversation surface）。
async function hasConversationContent(port, targetSelector = currentTargetSelector) {
  try {
    const v = await cdpEval(port, `!!document.querySelector('main [data-thread-find-target="conversation"]')`, targetSelector);
    return v === true || v === "true";
  } catch (error) {
    if (shouldPropagateCdpTargetError(error)) throw error;
    return false;
  }
}

function parseArgs(argv) {
  const envPort = Number(process.env.CCM_CDP_PORT || process.env.CODEX_CDP_PORT);
  const defaultPort = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : 9229;
  const envTarget = String(process.env.CCM_CDP_TARGET || "").trim();
  const args = { thread: null, all: false, detail: false, watch: false, cdp: false, port: defaultPort, target: envTarget || DEFAULT_TARGET_SELECTOR };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--thread") args.thread = argv[i + 1];
    else if (a === "--all") args.all = true;
    else if (a === "--detail") args.detail = true;
    else if (a === "--watch") args.watch = true;
    else if (a === "--cdp") args.cdp = true;
    else if (a === "--target" && argv[i + 1]) args.target = String(argv[i + 1]).trim() || DEFAULT_TARGET_SELECTOR;
    else if (a === "--port") {
      const port = Number(argv[i + 1]);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) args.port = port;
    }
  }
  return args;
}

// --all：按时间倒序列出每个对话的累计消耗
function printAllThreads() {
  const files = findRolloutFiles().sort((a, b) => b.localeCompare(a));
  if (!files.length) {
    console.log("未找到任何会话记录: " + SESSIONS_DIR);
    return;
  }
  console.log("=== 每个对话的 token 消耗量 ===");
  for (const file of files) {
    const parsed = parseFile(file);
    if (!parsed) continue;
    const stats = buildStats(parsed, { retainRequests: false });
    console.log(
      `${stats.date || ""}  ${(stats.threadId || "?").slice(0, 8)}…  ${compactNumber(stats.sessionTotal)} tokens (${stats.requestCount} 次请求, ${stats.turns.length} 轮)`,
    );
  }
}

// 环境不满足时只提示、不中断：非 CDP 的只读子命令仍然可用
function reportRuntimeWarnings(environment) {
  if (!environment.platformSupported) {
    console.warn("[提示] 当前系统不是 Windows。Tokens UI For Codex 目前只支持 Windows 桌面版。");
  }
  if (!environment.nodeSupported) {
    console.warn("[提示] 当前 Node.js " + process.versions.node + " 低于 CDP 模式要求；请安装 Node.js 22 或更高版本。");
  }
  if (!environment.codexPlusPlusInstalled) {
    console.warn("[提示] 未检测到 Codex++ 用户脚本目录：" + CODEX_PLUS_PLUS_USER_SCRIPTS + "；请先安装 Codex++，否则页面统计条无法注入。");
  }
}

function assertCdpRuntimeAvailable() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 22 || typeof WebSocket !== "function") {
    throw new Error("CDP 模式需要 Node.js 22 或更高版本（当前 " + process.versions.node + "）。");
  }
}

// ---------------------------------------------------------------------------
// watch 主循环
//
// 每轮做四件事：读取当前对话 → 定位会话文件 → 计算统计 → 按需推送。
// 跨轮状态集中在 session 对象里，函数之间靠它传递，避免层层嵌套的闭包。
// 轮询周期固定 1 秒；数据变化立即推送，无变化时按 HEARTBEAT_INTERVAL_MS 固定心跳推送。
// ---------------------------------------------------------------------------

const WATCH_TICK_MS = 1000;

function createWatchSession(args) {
  return {
    args,
    lastKey: "",
    lastPushAt: 0,
    lastRealThreadId: "",
    lastStatsFile: "",
    lastParsed: null,
    lastStats: null,
    lastPayload: null,
    lastPayloadJson: "",
    lastError: "",
    lastErrorAt: 0,
    lastCdpConnectionUrl: "",
    lastHealthKey: "",
    lastEchoLogKey: "",
    lastConflictLogKey: 0,
    health: monitorHealthFor(args),
    lastGoodPushAt: 0,
    parser: null,
    parserFile: "",
  };
}

// 把页面上的对话 ID 落成「真实会话文件的 threadId」。
// 占位对话（client-new-thread:<uuid>）需要先学习；学不到就返回 null（界面显示 0）。
async function resolveWatchThread(args, session, rawThread) {
  if (!isClientNewThread(rawThread)) return { thread: rawThread };

  const placeholder = clientThreadUuid(rawThread);
  if (!(placeholder in clientState.activatedAt)) {
    clientState.activatedAt[placeholder] = Date.now();
    saveClientState();
  }

  const learned = clientState.clientMap[placeholder];
  if (learned) return { thread: learned };

  // 排除上一个真实对话的文件，避免刚离开旧对话的瞬间误关联。
  const candidate = findNewestClientFileSince(clientState.activatedAt[placeholder], session.lastRealThreadId);
  if (candidate) {
    clientState.clientMap[placeholder] = candidate;
    saveClientState();
    return { thread: candidate };
  }

  // 兜底：修复前已存在、已有内容的占位对话，其文件创建时间早于激活时间。
  if (await hasConversationContent(args.port, args.target)) {
    const claimed = new Set(Object.values(clientState.clientMap));
    const fallback = findNewestUnclaimedFile(session.lastRealThreadId, claimed);
    if (fallback) {
      clientState.clientMap[placeholder] = fallback;
      saveClientState();
      return { thread: fallback };
    }
  }

  // 仍是空白新对话 -> 显示 0，不回退到上一个对话
  return { thread: null };
}

// 会话文件切换时重置增量解析器与统计缓存
function resetParserForFile(session, file) {
  session.parserFile = file || "";
  session.parser = file ? new IncrementalRolloutParser(file) : null;
  session.lastStatsFile = "";
  session.lastParsed = null;
  session.lastStats = null;
  session.lastPayload = null;
  session.lastPayloadJson = "";
}

function readWatchStats(session, thread) {
  // 没有真实对话（空白新对话、占位对话未学习、页面尚未加载完）时统一显示 0
  if (!thread || thread === NEW_THREAD) return { file: null, parsed: null, stats: emptyStats(null, null) };

  const file = resolveFile(thread);
  if (file !== session.parserFile) resetParserForFile(session, file);

  const parsed = session.parser ? session.parser.readNew() : null;
  if (!parsed) {
    // 对话存在但还没有数据 -> 显示 0
    return { file, parsed: null, stats: emptyStats(thread, file) };
  }

  // 解析结果对象未变时可以复用上一轮统计，避免每秒重复聚合
  if (file === session.lastStatsFile && parsed === session.lastParsed && session.lastStats) {
    return { file, parsed, stats: session.lastStats };
  }

  const stats = buildStats(parsed, { retainRequests: false });
  session.lastStatsFile = file;
  session.lastParsed = parsed;
  session.lastStats = stats;
  session.lastPayload = null;
  session.lastPayloadJson = "";
  return { file, parsed, stats };
}

function nextWatchHealth(args, session, parsed, rawThread, connectionState) {
  const dataFresh = !!parsed;
  const nowMs = Date.now();
  if (dataFresh) session.lastGoodPushAt = nowMs;
  // 有历史成功推送、但当前拿不到数据超过阈值 → stale-data（区别于「从未拿到数据」）
  const stale = !dataFresh && session.lastGoodPushAt > 0 && nowMs - session.lastGoodPushAt > STALE_DATA_AFTER_MS;
  const recovered = dataFresh && session.health.status !== "healthy" && session.health.status !== "starting";
  return monitorHealthFor(args, {
    status: dataFresh
      ? "healthy"
      : stale
        ? "stale-data"
        : rawThread == null
          ? "waiting-for-page"
          : "waiting-for-data",
    recoveryState: recovered ? "recovered" : dataFresh ? "idle" : session.health.recoveryState,
    ...connectionState,
    dataFresh,
    lastSuccessAt: dataFresh
      ? session.health.lastSuccessAt || new Date().toISOString()
      : session.health.lastSuccessAt || null,
    lastErrorCode: null,
    lastErrorAt: null,
  });
}

// 页面重绘判据：只把真正影响显示的数字拼进 key，避免无谓推送
function buildWatchKey(file, stats, currentTurn, lastRequest) {
  return [
    file || "",
    stats.threadId || "",
    stats.modelContextWindow || "",
    stats.requestCount,
    stats.sessionTotal,
    stats.sessionInput,
    stats.sessionCached,
    stats.sessionOutput,
    stats.contextUsed,
    stats.turns.length,
    currentTurn ? currentTurn.total : "",
    currentTurn ? currentTurn.input : "",
    currentTurn ? currentTurn.cached : "",
    currentTurn ? currentTurn.output : "",
    currentTurn ? currentTurn.requests.length : "",
    lastRequest ? lastRequest.ts : "",
    lastRequest ? lastRequest.lastTotal : "",
    stats.modelSwitchCount || 0,
    stats.cumulativeResetCount || 0,
  ].join("|");
}

function logStatsAnomalies(session, stats) {
  // 错峰回声只在「超过阈值」的记录存在时打一行日志（附 top-3 时间戳），数值没变化不重复打
  const echo = stats.echoStats;
  if (echo) {
    const echoKey = [echo.total, echo.overThreshold, echo.topLag.map((item) => item.ts).join(",")].join("|");
    if (echo.overThreshold > 0 && echoKey !== session.lastEchoLogKey) {
      session.lastEchoLogKey = echoKey;
      monitorLog(
        "错峰回声: " + echo.overThreshold + " 条超过 " + Math.round(echo.thresholdMs / 1000) +
          "s（会话回声共 " + echo.total + " 条，仍按一次请求计），top3 时间戳: " +
          echo.topLag.map((item) => item.ts).join(" / "),
      );
    }
  }
  // 真冲突（同 response_id 或同 ts 但数值不同）非 0 即报警
  if (stats.formatConflictCount > 0 && stats.formatConflictCount !== session.lastConflictLogKey) {
    session.lastConflictLogKey = stats.formatConflictCount;
    monitorLog("真冲突: " + stats.formatConflictCount + " 条（同 response_id 或同 ts 但数值不同），需排查");
  }
}

async function publishWatchRound(args, session, context) {
  const { file, stats, rawThread, connection, connectionState } = context;
  if (!stats) return;

  if (context.thread && context.thread !== NEW_THREAD && stats.threadId) session.lastRealThreadId = stats.threadId;

  const currentTurn = stats.turns.length ? stats.turns[stats.turns.length - 1] : null;
  const lastRequest = currentTurn && currentTurn.requests.length
    ? currentTurn.requests[currentTurn.requests.length - 1]
    : null;

  session.health = nextWatchHealth(args, session, context.parsed, rawThread, connectionState);

  const key = buildWatchKey(file, stats, currentTurn, lastRequest);
  const changed = key !== session.lastKey;
  const connectionUrl = (connection && connection.url) || "";
  const connectionChanged = args.cdp && connectionUrl !== session.lastCdpConnectionUrl;
  const heartbeat = args.cdp && Date.now() - session.lastPushAt > HEARTBEAT_INTERVAL_MS;
  const healthChanged = healthKeyOf(session.health) !== session.lastHealthKey;

  if (!(changed || heartbeat || connectionChanged || healthChanged)) return;

  if (changed) session.lastKey = key;

  if (args.cdp) {
    // 固定心跳也要重建负载以刷新 updatedAt；页面只在数据键变化时重绘，不会抖动
    if (changed || healthChanged || connectionChanged || heartbeat || !session.lastPayload) {
      session.lastPayload = payloadFor(stats, session.health);
      session.lastPayloadJson = JSON.stringify(session.lastPayload);
    }
    await cdpPush(args.port, session.lastPayload, session.lastPayloadJson, args.target);
    session.lastPushAt = Date.now();
    session.lastCdpConnectionUrl = connectionUrl;
    if (connection) connection.pageChanged = false;
    session.lastError = "";
    if (changed || healthChanged) {
      monitorLog("已推送: 累计 " + compactNumber(stats.sessionTotal) + " tokens，状态 " + session.health.status);
    }
    logStatsAnomalies(session, stats);
  } else if (changed) {
    monitorLog("会话累计 " + compactNumber(stats.sessionTotal) + " tokens / " + stats.requestCount + " 次请求");
  }

  session.lastHealthKey = healthKeyOf(session.health);
  persistMonitorHealth(session.health);
}

async function handleWatchError(args, session, error) {
  session.health = healthForError(error, args, session.health);
  const errorHealthKey = healthKeyOf(session.health);
  if (errorHealthKey !== session.lastHealthKey) {
    session.lastHealthKey = errorHealthKey;
    persistMonitorHealth(session.health);
  }
  if (!args.cdp) return;

  const message = error && error.message ? error.message : String(error);
  const now = Date.now();
  if (message !== session.lastError || now - session.lastErrorAt >= 10000) {
    monitorLog("推送失败: " + message);
    session.lastError = message;
    session.lastErrorAt = now;
  }

  // 目标选择失败与协议不匹配属于「需要用户处理」的状态，不再往页面灌空数据
  const skipErrorPush = ["CDP_TARGET_SELECTION_REQUIRED", "CDP_PROTOCOL_MISMATCH"].includes(error && error.code);
  if (skipErrorPush || !cdpConnection || cdpConnection.port !== args.port) return;

  try {
    const errorPayload = payloadFor(emptyStats(null, null), session.health);
    const errorPayloadJson = JSON.stringify(errorPayload);
    await cdpPush(args.port, errorPayload, errorPayloadJson, args.target);
    session.lastPushAt = Date.now();
    session.lastPayload = errorPayload;
    session.lastPayloadJson = errorPayloadJson;
  } catch {
    // 连错误状态都推不过去时不再重试，等下一轮
  }
}

async function runWatchRound(args, session) {
  const rawThread = args.thread || (await activeThreadId(args.port, args.target));
  const connection = cdpConnection && cdpConnection.port === args.port ? cdpConnection : null;
  const connectionState = {
    cdpReachable: !!connection,
    pageAttached: !!connection,
    targetSelection: (connection && connection.targetSelection) || "unknown",
    targetCount: (connection && connection.targetCount) || 0,
  };

  const { thread } = await resolveWatchThread(args, session, rawThread);
  const { file, parsed, stats } = readWatchStats(session, thread);
  await publishWatchRound(args, session, { thread, file, parsed, stats, rawThread, connection, connectionState });
}

async function runWatchLoop(args) {
  // 多来源启动（计划任务、兜底巡检、手动）时只允许一份实例存活
  if (!acquireSingleInstanceLock()) {
    monitorLog("已有监控实例在运行，本进程退出（PID " + process.pid + "）。");
    process.exit(0);
  }
  const session = createWatchSession(args);
  persistMonitorHealth(session.health);
  pruneMonitorLogs();
  monitorLog(
    "监控启动 (PID " + process.pid + ")，轮询 1s" + (args.cdp ? "，CDP 推送模式" : "") + "，日志目录 " + LOG_DIR,
  );

  // 防御：控制台窗口被关闭时 Windows 会广播 CTRL_CLOSE，Node 把它映射成 SIGHUP。
  // 监控是被计划任务拉起的后台进程，不应该因为用户关掉某个终端窗口就消失。
  // 这里只忽略 SIGHUP；SIGINT（Ctrl+C）保持默认行为，手动调试时仍可正常停止。
  try {
    process.on("SIGHUP", () => {
      monitorLog("收到 SIGHUP（控制台可能被关闭）；监控继续运行。");
    });
  } catch {
    // 平台不支持时忽略
  }

  for (;;) {
    try {
      await runWatchRound(args, session);
    } catch (error) {
      await handleWatchError(args, session, error);
    }
    await new Promise((resolve) => setTimeout(resolve, WATCH_TICK_MS));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  currentTargetSelector = args.target;
  reportRuntimeWarnings(environmentSnapshot());
  if (args.cdp) assertCdpRuntimeAvailable();

  if (args.all) {
    printAllThreads();
    return;
  }

  if (args.watch) {
    await runWatchLoop(args);
    return;
  }

  const file = resolveFile(args.thread);
  if (!file) {
    console.log("未找到会话记录: " + SESSIONS_DIR);
    process.exit(1);
  }
  const parsed = parseFile(file);
  if (!parsed) {
    console.log("会话文件为空或格式无法解析: " + file);
    process.exit(1);
  }
  const stats = buildStats(parsed, { retainRequests: args.detail });
  printStats(stats, { detail: args.detail });

  if (args.cdp) {
    await cdpPush(args.port, payloadFor(stats));
    console.log("");
    console.log("已写入 Codex 页面 (port " + args.port + ")");
    closeCdpConnection("one-shot complete");
  }
}

if (!process.env.CCM_TOKENS_AS_MODULE) {
  main().catch((e) => {
    console.error("错误: " + (e && e.message ? e.message : e));
    process.exit(1);
  });
}

export {
  SESSIONS_DIR,
  CLIENT_MAP_FILE,
  clientState,
  saveClientState,
  isClientNewThread,
  clientThreadUuid,
  findNewestClientFileSince,
  findNewestUnclaimedFile,
  hasConversationContent,
  findRolloutFiles,
  threadIdOf,
  resolveFile,
  emptyStats,
  IncrementalRolloutParser,
  processParserEvent,
  findCdpPages,
  findCdpPage,
  CdpTargetError,
  parseFile,
  buildStats,
  payloadFor,
  monitorHealthFor,
  healthKeyOf,
};

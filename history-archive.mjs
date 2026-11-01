import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HISTORY_RETENTION_DAYS = 60;
export const HISTORY_FILE_MAX_BYTES = 32 * 1024 * 1024;
export const HISTORY_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const HISTORY_RANGE_KEYS = Object.freeze(["today", "3d", "7d", "30d", "all"]);

function localDayStart(now, daysBack = 0) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysBack);
  return date.getTime();
}

function localDayKey(now) {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rangeStart(now, range) {
  if (range === "today") return localDayStart(now, 0);
  if (range === "3d") return localDayStart(now, 2);
  if (range === "7d") return localDayStart(now, 6);
  if (range === "30d") return localDayStart(now, 29);
  return null;
}

function sessionHashOf(threadId) {
  return crypto
    .createHash("sha256")
    .update(String(threadId || ""))
    .digest("hex")
    .slice(0, 32);
}

function hashKey(parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

function monthKey(now) {
  return new Date(now).toISOString().slice(0, 7).replace("-", "");
}

function locateTurnIndex(turns, record) {
  if (record.turnId) {
    const exact = turns.findIndex((turn) => turn && turn.turnId === record.turnId);
    if (exact >= 0) return exact;
  }
  const ts = record.ts || "";
  let low = 0;
  let high = turns.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = turns[middle] && turns[middle].start ? turns[middle].start : "";
    if (!start || start <= ts) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found >= 0 ? found : turns.length ? 0 : -1;
}

function readKeys(file) {
  const keys = [];
  try {
    const text = fs.readFileSync(file, "utf8");
    const pattern = /"key":"([0-9a-f]{24})"/g;
    let match;
    while ((match = pattern.exec(text))) keys.push(match[1]);
  } catch {}
  return keys;
}

export class UsageHistoryArchive {
  constructor(
    root,
    {
      retentionDays = HISTORY_RETENTION_DAYS,
      maxFileBytes = HISTORY_FILE_MAX_BYTES,
      cleanupIntervalMs = HISTORY_CLEANUP_INTERVAL_MS,
    } = {},
  ) {
    this.root = root;
    this.retentionDays = retentionDays;
    this.maxFileBytes = maxFileBytes;
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.sessions = new Map();
    this.rangeCache = new Map();
    this.lastCleanupAt = 0;
  }

  cleanup(now = Date.now()) {
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    try {
      const sessionsRoot = path.join(this.root, "sessions");
      if (!fs.existsSync(sessionsRoot)) return;
      for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[0-9a-f]{32}$/.test(entry.name)) continue;
        const dir = path.join(sessionsRoot, entry.name);
        let newest = 0;
        for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!file.isFile()) continue;
          const filePath = path.join(dir, file.name);
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            fs.rmSync(filePath, { force: true });
          } else {
            newest = Math.max(newest, stat.mtimeMs);
          }
        }
        if (newest < cutoff) fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {}
    this.rangeCache.clear();
    this.lastCleanupAt = now;
  }

  loadSession(threadId) {
    const hash = sessionHashOf(threadId);
    const cached = this.sessions.get(hash);
    if (cached) return cached;
    const dir = path.join(this.root, "sessions", hash);
    fs.mkdirSync(dir, { recursive: true });
    const seen = new Set();
    for (const name of fs.readdirSync(dir)) {
      if (!/^requests-\d{6}(?:-\d{3})?\.jsonl$/.test(name)) continue;
      for (const key of readKeys(path.join(dir, name))) seen.add(key);
    }
    const state = {
      hash,
      dir,
      seen,
      turnCounts: new Map(),
      lastRecordCount: 0,
      lastTurnsJson: "",
      archiveCalls: 0,
    };
    this.sessions.set(hash, state);
    return state;
  }

  requestFile(state, now) {
    const month = monthKey(now);
    const base = path.join(state.dir, "requests-" + month + ".jsonl");
    if (!fs.existsSync(base) || fs.statSync(base).size < this.maxFileBytes) return base;
    let sequence = 2;
    while (true) {
      const candidate = path.join(state.dir, "requests-" + month + "-" + String(sequence).padStart(3, "0") + ".jsonl");
      if (!fs.existsSync(candidate) || fs.statSync(candidate).size < this.maxFileBytes) return candidate;
      sequence += 1;
    }
  }

  writeTurnSnapshot(state, turns, now) {
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    const snapshot = {
      v: 1,
      sessionHash: state.hash,
      updatedAt: new Date(now).toISOString(),
      turns: turns
        .map((turn, index) => ({
          index: index + 1,
          start: turn.start || "",
          startLabel: turn.startLabel || "",
          requests: turn.requestCount || 0,
          input: turn.input || 0,
          cached: turn.cached == null ? null : turn.cached,
          output: turn.output || 0,
          total: turn.total || 0,
          wallMs: Number.isFinite(turn.wallMs) ? turn.wallMs : null,
          toolWallMs: Number.isFinite(turn.toolWallMs) ? turn.toolWallMs : null,
          toolCallCount: Number.isFinite(turn.toolCallCount) ? turn.toolCallCount : 0,
          ttftMs: Number.isFinite(turn.ttftMs) ? turn.ttftMs : null,
          timingCoverage: Number.isFinite(turn.timingCoverage) ? turn.timingCoverage : null,
          timingQuality: typeof turn.timingQuality === "string" ? turn.timingQuality : "low",
        }))
        .filter((turn) => {
          const startedAt = Date.parse(turn.start);
          return !Number.isFinite(startedAt) || startedAt >= cutoff;
        }),
    };
    const text = JSON.stringify(snapshot);
    if (text === state.lastTurnsJson) return false;
    const file = path.join(state.dir, "turns.json");
    const temp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, text, "utf8");
    try {
      fs.renameSync(temp, file);
    } catch {
      fs.copyFileSync(temp, file);
      fs.rmSync(temp, { force: true });
    }
    state.lastTurnsJson = text;
    return true;
  }

  archiveSession({ threadId, turns, records, now = Date.now() }) {
    if (!threadId || !Array.isArray(turns) || !Array.isArray(records)) return null;
    if (!this.lastCleanupAt || now - this.lastCleanupAt >= this.cleanupIntervalMs) this.cleanup(now);

    const state = this.loadSession(threadId);
    const cutoffMs = now - this.retentionDays * 24 * 60 * 60 * 1000;
    const shrink = records.length < state.lastRecordCount;
    const periodicFullScan = state.archiveCalls > 0 && state.archiveCalls % 100 === 0;
    const start = shrink || state.archiveCalls === 0 || periodicFullScan ? 0 : state.lastRecordCount;
    if (start === 0) state.turnCounts.clear();

    const lines = [];
    for (let index = start; index < records.length; index += 1) {
      const record = records[index];
      const tsMs = Date.parse(record && record.ts);
      if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
      const turnIndex = locateTurnIndex(turns, record);
      if (turnIndex < 0) continue;
      const requestIndex = (state.turnCounts.get(turnIndex) || 0) + 1;
      state.turnCounts.set(turnIndex, requestIndex);
      const threadTotal =
        record.threadUsage && Number.isFinite(record.threadUsage.total) ? record.threadUsage.total : null;
      const turnTotal = record.turnUsage && Number.isFinite(record.turnUsage.total) ? record.turnUsage.total : null;
      const key = hashKey([
        state.hash,
        String(turnIndex + 1),
        record.ts || "",
        String(record.input),
        String(record.cached),
        String(record.output),
        String(record.requestTotal),
        String(threadTotal),
        String(turnTotal),
      ]);
      if (state.seen.has(key)) continue;
      state.seen.add(key);
      lines.push(
        JSON.stringify({
          v: 1,
          kind: "request",
          key,
          sessionHash: state.hash,
          observedAt: new Date(now).toISOString(),
          turnIndex: turnIndex + 1,
          requestIndex,
          ts: record.ts || "",
          input: record.input == null ? null : record.input,
          cached: record.cached == null ? null : record.cached,
          uncached: record.input != null && record.cached != null ? Math.max(0, record.input - record.cached) : null,
          output: record.output == null ? null : record.output,
          total: record.requestTotal == null ? null : record.requestTotal,
          threadTotal,
          turnTotal,
        }),
      );
    }

    if (lines.length) {
      fs.appendFileSync(this.requestFile(state, now), lines.join("\n") + "\n", "utf8");
    }
    const turnsChanged = this.writeTurnSnapshot(state, turns, now);
    if (lines.length || turnsChanged) this.rangeCache.clear();
    state.lastRecordCount = records.length;
    state.archiveCalls += 1;
    return {
      sessionHash: state.hash,
      appended: lines.length,
      requestCount: records.length,
      turnCount: turns.length,
      retentionDays: this.retentionDays,
    };
  }

  aggregateRange(range, now = Date.now()) {
    if (!HISTORY_RANGE_KEYS.includes(range)) return null;
    const cacheKey = range + ":" + localDayKey(now);
    if (this.rangeCache.has(cacheKey)) return this.rangeCache.get(cacheKey);

    const cutoff = rangeStart(now, range);
    const summary = {
      range,
      available: false,
      retentionDays: this.retentionDays,
      cutoffAt: cutoff == null ? null : new Date(cutoff).toISOString(),
      generatedAt: new Date(now).toISOString(),
      availableFrom: null,
      availableThrough: null,
      sessionCount: 0,
      turnCount: 0,
      requestCount: 0,
      input: 0,
      cached: 0,
      output: 0,
      total: 0,
      cacheComplete: true,
      wallMs: 0,
      toolWallMs: 0,
      toolTimingSampleCount: 0,
      toolCallCount: 0,
      ttftTotalMs: 0,
      ttftSampleCount: 0,
      ttftAvgMs: null,
      effectiveMs: null,
      effectiveTps: null,
      timingSampleCount: 0,
    };

    const sessionsRoot = path.join(this.root, "sessions");
    try {
      if (!fs.existsSync(sessionsRoot)) {
        this.rangeCache.set(cacheKey, summary);
        return summary;
      }
    } catch {
      this.rangeCache.set(cacheKey, summary);
      return summary;
    }

    for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{32}$/.test(entry.name)) continue;
      const snapshotFile = path.join(sessionsRoot, entry.name, "turns.json");
      if (!fs.existsSync(snapshotFile)) continue;
      let snapshot;
      try {
        snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8").replace(/^\uFEFF/, ""));
      } catch {
        continue;
      }
      if (!snapshot || !Array.isArray(snapshot.turns)) continue;
      let sessionIncluded = false;
      for (const turn of snapshot.turns) {
        const startedAt = Date.parse(turn && turn.start);
        if (!Number.isFinite(startedAt)) continue;
        if (cutoff != null && startedAt < cutoff) continue;
        sessionIncluded = true;
        summary.turnCount += 1;
        summary.requestCount += Number.isFinite(turn.requests) ? turn.requests : 0;
        summary.input += Number.isFinite(turn.input) ? turn.input : 0;
        summary.output += Number.isFinite(turn.output) ? turn.output : 0;
        summary.total += Number.isFinite(turn.total) ? turn.total : 0;
        if (Number.isFinite(turn.cached)) summary.cached += turn.cached;
        else if (Number.isFinite(turn.input) && turn.input > 0) summary.cacheComplete = false;
        if (Number.isFinite(turn.wallMs)) {
          summary.wallMs += turn.wallMs;
          summary.timingSampleCount += 1;
        }
        if (Number.isFinite(turn.toolWallMs)) {
          summary.toolWallMs += turn.toolWallMs;
          summary.toolTimingSampleCount += 1;
        }
        if (Number.isFinite(turn.toolCallCount)) summary.toolCallCount += turn.toolCallCount;
        if (Number.isFinite(turn.ttftMs)) {
          summary.ttftTotalMs += turn.ttftMs;
          summary.ttftSampleCount += 1;
        }
        if (!summary.availableFrom || turn.start < summary.availableFrom) {
          summary.availableFrom = turn.start;
        }
        if (!summary.availableThrough || turn.start > summary.availableThrough) {
          summary.availableThrough = turn.start;
        }
      }
      if (sessionIncluded) summary.sessionCount += 1;
    }

    summary.available =
      summary.turnCount > 0 || summary.requestCount > 0 || summary.input > 0 || summary.output > 0 || summary.total > 0;
    summary.ttftAvgMs = summary.ttftSampleCount > 0 ? summary.ttftTotalMs / summary.ttftSampleCount : null;
    delete summary.ttftTotalMs;
    if (summary.timingSampleCount === 0) summary.wallMs = null;
    if (summary.toolTimingSampleCount === 0) summary.toolWallMs = null;
    delete summary.toolTimingSampleCount;
    summary.effectiveMs =
      Number.isFinite(summary.wallMs) && Number.isFinite(summary.toolWallMs) && summary.wallMs > summary.toolWallMs
        ? summary.wallMs - summary.toolWallMs
        : null;
    summary.effectiveTps =
      summary.effectiveMs > 0 && summary.output > 0 ? summary.output / (summary.effectiveMs / 1000) : null;
    this.rangeCache.set(cacheKey, summary);
    return summary;
  }
}

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HISTORY_RETENTION_DAYS, UsageHistoryArchive } from "../history-archive.mjs";

process.env.TUI_TOKENS_AS_MODULE = "1";
const tokenStats = await import("../token-stats.mjs");

function parseArgs(argv) {
  const options = {
    apply: false,
    historyRoot: tokenStats.RUNTIME_PATHS.historyDir,
    backupRoot: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") {
      options.apply = true;
    } else if (value === "--history-root") {
      options.historyRoot = argv[++index] || "";
    } else if (value === "--backup") {
      options.backupRoot = argv[++index] || "";
    } else {
      throw new Error("未知参数: " + value);
    }
  }
  if (!options.historyRoot) throw new Error("缺少 --history-root");
  if (options.apply && !options.backupRoot) throw new Error("--apply 必须同时提供 --backup");
  return options;
}

function hashThreadId(threadId) {
  return crypto
    .createHash("sha256")
    .update(String(threadId || ""))
    .digest("hex")
    .slice(0, 32);
}

function requestFiles(sessionDir) {
  return fs
    .readdirSync(sessionDir)
    .filter((name) => /^requests-\d{6}(?:-\d{3})?\.jsonl$/.test(name))
    .sort();
}

function logicalRecord(record) {
  const copy = { ...record };
  delete copy.observedAt;
  return JSON.stringify(copy);
}

function auditRequests(sessionDir, cutoffMs = null) {
  const files = requestFiles(sessionDir);
  const keptByFile = new Map();
  const seen = new Map();
  const failures = [];
  let total = 0;
  let duplicates = 0;
  let expired = 0;

  for (const name of files) {
    const text = fs.readFileSync(path.join(sessionDir, name), "utf8");
    const lines = text.split(/\r?\n/);
    const kept = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]) continue;
      total += 1;
      let record;
      try {
        record = JSON.parse(lines[index]);
      } catch {
        failures.push(`${name}:${index + 1}: invalid JSON`);
        continue;
      }
      if (typeof record.key !== "string" || !/^[0-9a-f]{24}$/.test(record.key)) {
        failures.push(`${name}:${index + 1}: invalid key`);
        continue;
      }
      for (const key of ["input", "cached", "output", "total", "threadTotal", "turnTotal"]) {
        if (record[key] != null && (!Number.isFinite(record[key]) || record[key] < 0)) {
          failures.push(`${name}:${index + 1}: invalid ${key}`);
        }
      }
      if (Number.isFinite(record.cached) && Number.isFinite(record.input) && record.cached > record.input) {
        failures.push(`${name}:${index + 1}: cached exceeds input`);
      }
      const observedTs = Date.parse(record.ts || "");
      if (!Number.isFinite(observedTs)) {
        failures.push(`${name}:${index + 1}: invalid ts`);
        continue;
      }
      if (cutoffMs != null && observedTs < cutoffMs) {
        expired += 1;
        continue;
      }
      const previous = seen.get(record.key);
      if (previous) {
        duplicates += 1;
        if (logicalRecord(previous) !== logicalRecord(record)) {
          failures.push(`${name}:${index + 1}: key collision with different content`);
        }
        continue;
      }
      seen.set(record.key, record);
      kept.push(lines[index]);
    }
    keptByFile.set(name, kept);
  }

  return { files, keptByFile, records: [...seen.values()], failures, total, duplicates, expired };
}

function sameTurnNumbers(previous, next) {
  const fields = ["start", "requests", "input", "cached", "output", "total"];
  const valueOf = (turn, field) => {
    if (!turn) return null;
    if (field === "requests") return turn.requestCount ?? turn.requests ?? null;
    return turn[field] ?? null;
  };
  for (const field of fields) {
    if (valueOf(previous, field) !== valueOf(next, field)) return false;
  }
  return true;
}

function turnsMatch(previousTurns, nextTurns) {
  if (!previousTurns.length || nextTurns.length < previousTurns.length) return false;
  for (let index = 0; index < previousTurns.length; index += 1) {
    const previous = previousTurns[index];
    const next = nextTurns[index];
    if (sameTurnNumbers(previous, next)) continue;

    // The live conversation can advance its last turn after the last archive write.
    // Rebuilding is safe only when every earlier turn is identical and the changed
    // last turn remains monotonic; new turns may already have been appended.
    const isLiveLastTurn = index === previousTurns.length - 1 && index === nextTurns.length - 1;
    if (!isLiveLastTurn) return false;
    if (
      !sameTurnNumbers(
        { ...previous, requests: 0, input: 0, cached: 0, output: 0, total: 0 },
        {
          ...next,
          requestCount: 0,
          input: 0,
          cached: 0,
          output: 0,
          total: 0,
        },
      )
    ) {
      return false;
    }
    if (
      !Number.isFinite(previous.requests) ||
      !Number.isFinite(next.requestCount) ||
      next.requestCount < previous.requests ||
      (Number.isFinite(previous.input) && (!Number.isFinite(next.input) || next.input < previous.input)) ||
      (Number.isFinite(previous.output) && (!Number.isFinite(next.output) || next.output < previous.output))
    ) {
      return false;
    }
  }
  return true;
}

function rawThreadsByHash() {
  const result = new Map();
  for (const file of tokenStats.findRolloutFiles()) {
    const threadId = tokenStats.threadIdOf(file);
    if (!threadId) continue;
    result.set(hashThreadId(threadId), threadId);
  }
  return result;
}

function parseRawStats(threadId) {
  const files = tokenStats.locateThreadFiles(tokenStats.findRolloutFiles(), threadId);
  if (!files.length) return null;
  const parsed = tokenStats.mergeSegments(files.map((file) => tokenStats.parseFile(file)));
  if (!parsed) return null;
  return tokenStats.buildStats(parsed, { retainRequests: false, includeArchiveRecords: true });
}

function withinRetention(turn, now) {
  const startedAt = Date.parse(turn && turn.start);
  return !Number.isFinite(startedAt) || startedAt >= now - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

function stageRebuild(sessionHash, threadId, stats, now) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tui-history-repair-"));
  const archive = new UsageHistoryArchive(root);
  archive.archiveSession({
    threadId,
    turns: stats.turns,
    records: stats.archiveRecords,
    now,
  });
  const sessionDir = path.join(root, "sessions", sessionHash);
  const stagedTurns = JSON.parse(fs.readFileSync(path.join(sessionDir, "turns.json"), "utf8"));
  const expectedTurns = stats.turns.filter((turn) => withinRetention(turn, now));
  if (expectedTurns.length !== stagedTurns.turns.length) {
    throw new Error("staged turn count mismatch");
  }
  for (let index = 0; index < expectedTurns.length; index += 1) {
    if (
      !sameTurnNumbers(expectedTurns[index], {
        ...stagedTurns.turns[index],
        requestCount: stagedTurns.turns[index].requests,
      })
    ) {
      throw new Error("staged turn values mismatch");
    }
  }
  return { root, sessionDir, stagedTurns };
}

function backupContainsSession(backupRoot, sessionHash) {
  return [
    path.join(backupRoot, "state", "history", "sessions", sessionHash),
    path.join(backupRoot, "history", "sessions", sessionHash),
    path.join(backupRoot, "sessions", sessionHash),
  ].some((candidate) => fs.existsSync(candidate));
}

function replaceFromStage(realDir, stagedDir) {
  for (const name of requestFiles(realDir)) {
    fs.rmSync(path.join(realDir, name), { force: true });
  }
  for (const name of requestFiles(stagedDir)) {
    fs.copyFileSync(path.join(stagedDir, name), path.join(realDir, name));
  }
  const turnsTemp = path.join(realDir, "turns.json." + process.pid + ".repair.tmp");
  fs.copyFileSync(path.join(stagedDir, "turns.json"), turnsTemp);
  fs.renameSync(turnsTemp, path.join(realDir, "turns.json"));
}

function rewriteDeduplicated(realDir, audit) {
  for (const [name, lines] of audit.keptByFile) {
    const file = path.join(realDir, name);
    if (!lines.length) {
      fs.rmSync(file, { force: true });
      continue;
    }
    const current = fs.readFileSync(file, "utf8");
    const next = lines.join("\n") + "\n";
    if (current === next) continue;
    const temp = file + "." + process.pid + ".repair.tmp";
    fs.writeFileSync(temp, next, "utf8");
    fs.renameSync(temp, file);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionsRoot = path.join(options.historyRoot, "sessions");
  if (!fs.existsSync(sessionsRoot)) throw new Error("history sessions directory not found");
  const now = Date.now();
  const cutoffMs = now - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const rawThreads = rawThreadsByHash();
  const report = [];
  const errors = [];

  for (const sessionHash of fs.readdirSync(sessionsRoot).sort()) {
    if (!/^[0-9a-f]{32}$/.test(sessionHash)) continue;
    const realDir = path.join(sessionsRoot, sessionHash);
    const turnsFile = path.join(realDir, "turns.json");
    if (!fs.existsSync(turnsFile)) continue;
    const snapshot = JSON.parse(fs.readFileSync(turnsFile, "utf8"));
    const previousTurns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
    const audit = auditRequests(realDir, cutoffMs);
    if (audit.failures.length) {
      errors.push(...audit.failures.map((failure) => `${sessionHash}: ${failure}`));
      report.push({
        sessionHash,
        action: "blocked-invalid-request-archive",
        failures: audit.failures.length,
      });
      continue;
    }

    const threadId = rawThreads.get(sessionHash);
    const stats = threadId ? parseRawStats(threadId) : null;
    if (stats && turnsMatch(previousTurns, stats.turns)) {
      if (options.apply && !backupContainsSession(options.backupRoot, sessionHash)) {
        throw new Error(`backup does not contain session ${sessionHash}`);
      }
      const staged = stageRebuild(sessionHash, threadId, stats, now);
      const stagedAudit = auditRequests(staged.sessionDir, cutoffMs);
      if (stagedAudit.failures.length || stagedAudit.duplicates) {
        throw new Error(`staged archive validation failed for ${sessionHash}`);
      }
      if (options.apply) replaceFromStage(realDir, staged.sessionDir);
      fs.rmSync(staged.root, { recursive: true, force: true });
      report.push({
        sessionHash,
        action: options.apply ? "rebuilt" : "would-rebuild",
        reason: "rollout token fields match archived turns",
        turns: staged.stagedTurns.turns.length,
        timedTurns: staged.stagedTurns.turns.filter((turn) => Number.isFinite(turn.wallMs)).length,
        requests: stagedAudit.total,
        exactDuplicateKeysRemoved: stagedAudit.duplicates,
        expiredRequestsRemoved: audit.expired,
      });
      continue;
    }

    const needsRewrite = audit.duplicates > 0 || audit.expired > 0;
    if (options.apply && needsRewrite) rewriteDeduplicated(realDir, audit);
    const removeExpiredSession = options.apply && !previousTurns.length && audit.records.length === 0;
    if (removeExpiredSession) {
      if (!backupContainsSession(options.backupRoot, sessionHash)) {
        throw new Error(`backup does not contain session ${sessionHash}`);
      }
      fs.rmSync(realDir, { recursive: true, force: true });
    }
    report.push({
      sessionHash,
      action: removeExpiredSession
        ? "removed-expired-session"
        : !stats
          ? options.apply && needsRewrite
            ? "pruned-no-raw-rollout"
            : "audited-no-raw-rollout"
          : options.apply && needsRewrite
            ? "pruned-raw-mismatch"
            : "skipped-raw-mismatch",
      reason: stats ? "archived token fields differ from current parser" : "raw rollout unavailable",
      turns: previousTurns.length,
      timedTurns: previousTurns.filter((turn) => Number.isFinite(turn.wallMs)).length,
      requests: audit.records.length,
      exactDuplicateKeysRemoved: audit.duplicates,
      expiredRequestsRemoved: audit.expired,
    });
  }

  const output = {
    mode: options.apply ? "apply" : "dry-run",
    historyRoot: options.historyRoot,
    sessions: report,
    errors,
  };
  console.log(JSON.stringify(output, null, 2));
  if (errors.length) process.exitCode = 1;
}

main();

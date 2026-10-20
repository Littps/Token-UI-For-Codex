import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UsageHistoryArchive, HISTORY_RETENTION_DAYS } from "../history-archive.mjs";

function record(index, turnId, baseMs) {
  return {
    ts: new Date(baseMs + index * 1000).toISOString(),
    ordinal: index + 2,
    turnId,
    input: 1000 + index,
    output: 100 + index,
    cached: 800,
    requestTotal: 1100 + index * 2,
    threadUsage: { total: (index + 1) * 1100 },
    turnUsage: { total: (index + 1) * 1100 },
  };
}

test("历史归档：超过 500 条仍全部写入本地，重复刷新不重复追加", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tui-history-"));
  try {
    const archive = new UsageHistoryArchive(root);
    const base = Date.parse("2026-10-17T00:00:00.000Z");
    const turns = [
      {
        turnId: "T0",
        start: "2026-01-01T00:00:00.000Z",
        startLabel: "00:00",
        requestCount: 1,
        input: 1,
        cached: 1,
        output: 1,
        total: 2,
      },
      {
        turnId: "T1",
        start: new Date(base).toISOString(),
        startLabel: "08:00",
        requestCount: 200,
        input: 1,
        cached: 1,
        output: 1,
        total: 2,
      },
      {
        turnId: "T2",
        start: new Date(base + 200000).toISOString(),
        startLabel: "08:03",
        requestCount: 200,
        input: 1,
        cached: 1,
        output: 1,
        total: 2,
      },
      {
        turnId: "T3",
        start: new Date(base + 400000).toISOString(),
        startLabel: "08:06",
        requestCount: 120,
        input: 1,
        cached: 1,
        output: 1,
        total: 2,
      },
    ];
    const records = [
      ...Array.from({ length: 200 }, (_, index) => record(index, "T1", base)),
      ...Array.from({ length: 200 }, (_, index) => record(200 + index, "T2", base + 200000)),
      ...Array.from({ length: 120 }, (_, index) => record(400 + index, "T3", base + 400000)),
    ];
    const first = archive.archiveSession({ threadId: "thread-secret-value", turns, records, now: base + 500000 });
    assert.equal(first.appended, 520);

    const sessionDir = path.join(root, "sessions", first.sessionHash);
    const requestFiles = fs.readdirSync(sessionDir).filter((name) => name.startsWith("requests-"));
    const lines = requestFiles.flatMap((name) =>
      fs.readFileSync(path.join(sessionDir, name), "utf8").trim().split(/\r?\n/),
    );
    assert.equal(lines.length, 520);
    assert.ok(
      lines.every((line) => !line.includes("thread-secret-value")),
      "归档不能包含原始 threadId",
    );

    const second = archive.archiveSession({ threadId: "thread-secret-value", turns, records, now: base + 600000 });
    assert.equal(second.appended, 0, "相同记录重复刷新不能重复追加");

    const nextRecords = [...records, record(520, "T3", base + 520000)];
    turns.at(-1).requestCount += 1;
    const third = archive.archiveSession({
      threadId: "thread-secret-value",
      turns,
      records: nextRecords,
      now: base + 700000,
    });
    assert.equal(third.appended, 1);

    const turnSnapshot = JSON.parse(fs.readFileSync(path.join(sessionDir, "turns.json"), "utf8"));
    assert.equal(turnSnapshot.turns.length, 3);
    assert.equal(turnSnapshot.turns.at(-1).requests, 121);
    assert.ok(
      turnSnapshot.turns.every((turn) => turn.start !== "2026-01-01T00:00:00.000Z"),
      "超过 60 天的轮次摘要应被过滤",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("历史归档：超过 60 天的文件会自动清理", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tui-history-retention-"));
  try {
    const archive = new UsageHistoryArchive(root);
    const now = Date.parse("2026-10-17T00:00:00.000Z");
    const oldMs = now - (HISTORY_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
    const sessionDir = path.join(root, "sessions", "a".repeat(32));
    fs.mkdirSync(sessionDir, { recursive: true });
    const oldFile = path.join(sessionDir, "requests-202608.jsonl");
    const freshFile = path.join(sessionDir, "requests-202610.jsonl");
    fs.writeFileSync(oldFile, '{"key":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n', "utf8");
    fs.writeFileSync(freshFile, '{"key":"bbbbbbbbbbbbbbbbbbbbbbbb"}\n', "utf8");
    fs.utimesSync(oldFile, oldMs / 1000, oldMs / 1000);
    archive.cleanup(now);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(freshFile), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

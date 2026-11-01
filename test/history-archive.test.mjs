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

test("历史归档：按今日、3 日、7 日、30 日和全部范围汇总结构化轮次", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tui-history-range-"));
  try {
    const archive = new UsageHistoryArchive(root);
    const now = new Date();
    now.setHours(18, 0, 0, 0);
    const atDaysAgo = (days) => {
      const value = new Date(now);
      value.setDate(value.getDate() - days);
      return value.toISOString();
    };
    const writeSession = (index, turns) => {
      const dir = path.join(root, "sessions", String(index).padStart(32, "0"));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "turns.json"), JSON.stringify({ v: 1, turns }), "utf8");
    };
    writeSession(1, [
      {
        start: atDaysAgo(0),
        requests: 2,
        input: 100,
        cached: 80,
        output: 20,
        total: 120,
        wallMs: 5000,
        toolWallMs: 1000,
        toolCallCount: 3,
        ttftMs: 500,
      },
    ]);
    writeSession(2, [
      {
        start: atDaysAgo(3),
        requests: 1,
        input: 200,
        cached: 150,
        output: 30,
        total: 230,
        wallMs: 7000,
        toolWallMs: 2000,
        toolCallCount: 1,
        ttftMs: 700,
      },
      {
        start: atDaysAgo(10),
        requests: 1,
        input: 300,
        cached: 250,
        output: 40,
        total: 340,
        wallMs: 9000,
        toolWallMs: 3000,
        toolCallCount: 2,
        ttftMs: 900,
      },
    ]);
    writeSession(3, [
      {
        start: atDaysAgo(40),
        requests: 1,
        input: 400,
        cached: 350,
        output: 50,
        total: 450,
        wallMs: 11000,
        toolWallMs: 4000,
        toolCallCount: 4,
        ttftMs: 1100,
      },
    ]);
    writeSession(4, [
      {
        start: atDaysAgo(2),
        requests: 1,
        input: 110,
        cached: 90,
        output: 11,
        total: 121,
        wallMs: 4000,
        toolWallMs: 500,
        toolCallCount: 1,
        ttftMs: 400,
      },
    ]);

    const today = archive.aggregateRange("today", now.getTime());
    assert.equal(today.requestCount, 2);
    assert.equal(today.total, 120);
    assert.equal(today.sessionCount, 1);
    const threeDays = archive.aggregateRange("3d", now.getTime());
    assert.equal(threeDays.requestCount, 3);
    assert.equal(threeDays.total, 241);
    assert.equal(threeDays.sessionCount, 2);
    assert.equal(threeDays.timingSampleCount, 2);
    const sevenDays = archive.aggregateRange("7d", now.getTime());
    assert.equal(sevenDays.requestCount, 4);
    assert.equal(sevenDays.total, 471);
    assert.equal(sevenDays.sessionCount, 3);
    const thirtyDays = archive.aggregateRange("30d", now.getTime());
    assert.equal(thirtyDays.requestCount, 5);
    assert.equal(thirtyDays.total, 811);
    assert.equal(thirtyDays.sessionCount, 3);
    const all = archive.aggregateRange("all", now.getTime());
    assert.equal(all.requestCount, 6);
    assert.equal(all.total, 1261);
    assert.equal(all.sessionCount, 4);
    assert.equal(all.cacheComplete, true);
    assert.equal(all.ttftSampleCount, 5);
    assert.equal(all.toolCallCount, 11);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

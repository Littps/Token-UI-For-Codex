import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tokens-ui-test-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.LOCALAPPDATA = path.join(testRoot, "local");
process.env.APPDATA = path.join(testRoot, "roaming");
process.env.TUI_TOKENS_AS_MODULE = "1";
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

const stats = await import("../token-stats.mjs");
const protocol = await import("../protocol.mjs");

const threadId = "test-thread";
const file = path.join(testRoot, "rollout-2026-09-16T12-00-00-" + threadId + ".jsonl");

function event(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function user(timestamp) {
  return event(timestamp, "event_msg", { type: "user_message" });
}

function usage(timestamp, id, {
  input = 10,
  output = 3,
  cached = 2,
  total = input + output,
  turnId = "turn-1",
  turnTotal = total,
  threadTotal = total,
  // 线程级累计与单请求量是两套数字；默认沿用请求值，需要时显式传累计值。
  threadInput = input,
  threadOutput = output,
  threadCached = cached,
  model,
} = {}) {
  return event(timestamp, "token_usage_record", {
    response_id: id,
    turn_id: turnId,
    ...(model ? { model } : {}),
    usage: {
      input_tokens: input,
      output_tokens: output,
      cached_input_tokens: cached,
      total_tokens: total,
    },
    turn_token_usage: {
      input_tokens: input,
      output_tokens: output,
      cached_input_tokens: cached,
      total_tokens: turnTotal,
    },
    thread_token_usage: {
      input_tokens: threadInput,
      output_tokens: threadOutput,
      cached_input_tokens: threadCached,
      total_tokens: threadTotal,
    },
  });
}

function model(timestamp, value) {
  return event(timestamp, "turn_context", { model: value, model_context_window: 1000 });
}

function writeLines(lines) {
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

test("incremental parser handles partial lines, appends, duplicates and truncation", () => {
  const parser = new stats.IncrementalRolloutParser(file);
  const firstRecord = usage("2026-09-16T12:00:02.000Z", "r1");
  const first = user("2026-09-16T12:00:01.000Z") + "\n" + firstRecord.slice(0, -1);
  fs.writeFileSync(file, first, "utf8");
  let parsed = parser.readNew();
  assert.equal(parsed.userMessages.length, 1);
  assert.equal(parsed.usageRecords.length, 0);

  fs.appendFileSync(file, firstRecord.slice(-1) + "\n" + usage("2026-09-16T12:00:03.000Z", "r2") + "\n", "utf8");
  parsed = parser.readNew();
  assert.equal(parsed.usageRecords.length, 2);
  const offsetAfterAppend = parser.offset;

  fs.appendFileSync(file, usage("2026-09-16T12:00:03.000Z", "r2") + "\n", "utf8");
  parsed = parser.readNew();
  assert.equal(parsed.usageRecords.length, 2, "duplicate response_id must not count twice");
  assert.equal(parser.offset > offsetAfterAppend, true);

  writeLines([user("2026-09-16T12:01:01.000Z"), usage("2026-09-16T12:01:02.000Z", "new", { total: 20, turnTotal: 20, threadTotal: 20 })]);
  parsed = parser.readNew();
  assert.equal(parsed.usageRecords.length, 1, "truncation/rewrite must rebuild parser state");
  assert.equal(parsed.usageRecords[0].responseId, "new");
});

test("same-size replacement is detected by prefix fingerprint", () => {
  const parser = new stats.IncrementalRolloutParser(file);
  const a = usage("2026-09-16T12:02:01.000Z", "aa", { input: 10, output: 3, cached: 2, total: 13, turnTotal: 13, threadTotal: 13 });
  const b = usage("2026-09-16T12:02:01.000Z", "bb", { input: 10, output: 3, cached: 2, total: 23, turnTotal: 23, threadTotal: 23 });
  assert.equal(Buffer.byteLength(a), Buffer.byteLength(b));
  fs.writeFileSync(file, a + "\n", "utf8");
  let parsed = parser.readNew();
  assert.equal(parsed.usageRecords[0].responseId, "aa");
  fs.writeFileSync(file, b + "\n", "utf8");
  parsed = parser.readNew();
  assert.equal(parsed.usageRecords.length, 1);
  assert.equal(parsed.usageRecords[0].responseId, "bb");
});

test("out-of-order records are flagged and model switches are retained", () => {
  writeLines([
    user("2026-09-16T12:03:01.000Z"),
    user("2026-09-16T12:03:05.000Z"),
    model("2026-09-16T12:03:06.000Z", "model-a"),
    usage("2026-09-16T12:03:09.000Z", "r2", { turnId: "turn-2", model: "model-a", threadTotal: 20, turnTotal: 20 }),
    model("2026-09-16T12:03:07.000Z", "model-b"),
    usage("2026-09-16T12:03:08.000Z", "r1", { turnId: "turn-2", model: "model-b", threadTotal: 10, turnTotal: 10 }),
  ]);
  const parsed = new stats.IncrementalRolloutParser(file).readAll();
  assert.equal(parsed.modelChanges.length >= 2, true);
  const result = stats.buildStats(parsed, { retainRequests: true });
  assert.equal(result.modelSwitchCount >= 1, true);
  assert.equal(result.turns.length, 1, "explicit turn_id groups records consistently");
});

test("request total changes from context compression do not count as cumulative reset", () => {
  writeLines([
    user("2026-09-16T12:04:01.000Z"),
    usage("2026-09-16T12:04:02.000Z", "r1", { total: 100, turnTotal: 100, threadTotal: 100 }),
    usage("2026-09-16T12:04:03.000Z", "r2", { total: 50, turnTotal: 150, threadTotal: 200 }),
  ]);
  const result = stats.buildStats(new stats.IncrementalRolloutParser(file).readAll());
  assert.equal(result.contextUsed, 50);
  assert.equal(result.sessionTotal, 200);
  assert.equal(result.cumulativeResetCount, 0);
});

test("session and prompt cumulative resets are counted and normalized", () => {
  writeLines([
    user("2026-09-16T12:05:01.000Z"),
    usage("2026-09-16T12:05:02.000Z", "r1", { total: 100, turnTotal: 100, threadTotal: 100 }),
    usage("2026-09-16T12:05:03.000Z", "r2", { total: 10, turnTotal: 10, threadTotal: 10 }),
  ]);
  const result = stats.buildStats(new stats.IncrementalRolloutParser(file).readAll());
  assert.equal(result.sessionTotal, 110);
  assert.equal(result.turns.at(-1).total, 110);
  assert.equal(result.cumulativeResetCount, 2);
});

test("legacy token_count fallback also normalizes cumulative resets", () => {
  const parsed = {
    file,
    threadId,
    date: "2026-09-16T12-00-00",
    modelContextWindow: 1000,
    userMessages: [{ ts: "2026-09-16T12:06:01.000Z" }],
    counts: [
      { ts: "2026-09-16T12:06:02.000Z", total: 100, input: 10, output: 3, cached: 2, lastTotal: 13, totalInfo: { total: 100, input: 10, cached: 2, output: 3 } },
      { ts: "2026-09-16T12:06:03.000Z", total: 10, input: 4, output: 2, cached: 1, lastTotal: 6, totalInfo: { total: 10, input: 4, cached: 1, output: 2 } },
    ],
    usageRecords: [],
  };
  const result = stats.buildStats(parsed);
  assert.equal(result.sessionTotal, 110);
  assert.equal(result.cumulativeResetCount, 1);
});

test("context window is detected from task_started and token_count even after usage records", () => {
  const windowSize = 258400;
  const usageLine = usage("2026-09-16T12:07:01.000Z", "w1", { total: 120, turnTotal: 120, threadTotal: 120 });
  const taskStarted = event("2026-09-16T12:07:02.000Z", "event_msg", {
    type: "task_started",
    model_context_window: windowSize,
  });
  const tokenCount = event("2026-09-16T12:07:03.000Z", "event_msg", {
    type: "token_count",
    info: {
      model_context_window: windowSize,
      last_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50, total_tokens: 120 },
      total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50, total_tokens: 120 },
    },
  });

  // 关键顺序：token_usage_record 先出现，之后才是带上限的事件。
  writeLines([usageLine, taskStarted, tokenCount]);
  const parsed = new stats.IncrementalRolloutParser(file).readAll();
  assert.equal(parsed.modelContextWindow, windowSize);

  const result = stats.buildStats(parsed);
  assert.equal(result.modelContextWindow, windowSize);
  assert.ok(result.contextUsed <= windowSize, "上下文占用应受上限约束");

  const payload = stats.payloadFor(result);
  assert.equal(payload.modelContextWindow, windowSize, "负载必须携带上下文上限");
});

test("context window is still detected when only task_started carries it", () => {
  const windowSize = 1000000;
  writeLines([
    usage("2026-09-16T12:08:01.000Z", "w2", { total: 50, turnTotal: 50, threadTotal: 50 }),
    event("2026-09-16T12:08:02.000Z", "event_msg", { type: "task_started", model_context_window: windowSize }),
  ]);
  const parsed = new stats.IncrementalRolloutParser(file).readAll();
  assert.equal(parsed.modelContextWindow, windowSize);
  assert.equal(stats.payloadFor(stats.buildStats(parsed)).modelContextWindow, windowSize);
});

test("payload protocol validates and negotiates schema v2", () => {
  const payload = stats.payloadFor(stats.emptyStats(threadId, file));
  assert.equal(payload.protocolName, protocol.PROTOCOL_NAME);
  assert.equal(protocol.validatePayload(payload, { allowLegacy: false }).ok, true);
  assert.equal(protocol.negotiateSchemaVersion([1, 2]), 2);
  assert.equal(protocol.negotiateSchemaVersion([1]), null);
  assert.equal(protocol.validatePayload({ ...payload, protocolName: "wrong" }).ok, false);
});

test("checked JSON schema documents the same protocol contract", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/payload-v2.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.protocolName.const, protocol.PROTOCOL_NAME);
  assert.equal(schema.properties.schemaVersion.const, protocol.PROTOCOL_SCHEMA_VERSION);
  assert.equal(schema.properties.requestDetails.maxItems, 1000);
  assert.equal(schema.properties.turns.maxItems, 1000);
});

test("automatic target selection prefers the focused Codex window and manual selection is deterministic", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const pages = [
    { id: "target-a", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1/target-a" },
    { id: "target-b", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1/target-b" },
  ];
  globalThis.fetch = async () => ({ ok: true, json: async () => pages });
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen();
      });
    }

    send(raw) {
      const message = JSON.parse(raw);
      if (message.method !== "Runtime.evaluate") return;
      queueMicrotask(() => {
        if (!this.onmessage) return;
        const focused = this.url.endsWith("target-a");
        this.onmessage({ data: JSON.stringify({ id: message.id, result: { result: { value: JSON.stringify({ focused, visible: true, hasPanel: true }) } } }) });
      });
    }

    close() {
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const focused = await stats.findCdpPage(9229, "auto");
    assert.equal(focused.id, "target-a");
    assert.equal(focused.targetSelection, "focused");
    const manual = await stats.findCdpPage(9229, "target-b");
    assert.equal(manual.id, "target-b");
    assert.equal(manual.targetSelection, "manual");

    globalThis.WebSocket = class AmbiguousWebSocket {
      constructor() {
        this.readyState = 0;
        queueMicrotask(() => {
          this.readyState = 1;
          if (this.onopen) this.onopen();
        });
      }

      send(raw) {
        const message = JSON.parse(raw);
        queueMicrotask(() => {
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: message.id, result: { result: { value: JSON.stringify({ focused: false, visible: true }) } } }) });
        });
      }

      close() {
        this.readyState = 3;
      }
    };
    await assert.rejects(
      () => stats.findCdpPage(9229, "auto"),
      (error) => error && error.code === "CDP_TARGET_SELECTION_REQUIRED",
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

// ---- F1 规格 fixture（见 docs/F1-merge-spec.md）----

function tokenCount(timestamp, { window = 1000000, input = 40, output = 10, cached = 0, total, cumulativeInput, cumulativeCached, cumulativeOutput } = {}) {
  const cumulativeTotal = total != null ? total : input + output;
  return event(timestamp, "event_msg", {
    type: "token_count",
    info: {
      model_context_window: window,
      last_token_usage: {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cached,
        total_tokens: input + output,
      },
      total_token_usage: {
        input_tokens: cumulativeInput != null ? cumulativeInput : input,
        cached_input_tokens: cumulativeCached != null ? cumulativeCached : cached,
        output_tokens: cumulativeOutput != null ? cumulativeOutput : output,
        total_tokens: cumulativeTotal,
      },
    },
  });
}

function fixtureStats(lines, { incremental = false } = {}) {
  if (incremental) return stats.buildStats(new stats.IncrementalRolloutParser(file).readAll(), { retainRequests: false });
  writeLines(lines);
  return stats.buildStats(new stats.IncrementalRolloutParser(file).readAll(), { retainRequests: false });
}

test("F1-1 legacy-only：仅 token_count 也能完整统计", () => {
  const result = fixtureStats([
    tokenCount("2026-09-17T11:01:01.000Z", { total: 100, cumulativeInput: 90, cumulativeOutput: 10, cumulativeCached: 0 }),
    tokenCount("2026-09-17T11:01:02.000Z", { total: 300, cumulativeInput: 270, cumulativeOutput: 30, cumulativeCached: 100 }),
    tokenCount("2026-09-17T11:01:03.000Z", { total: 600, cumulativeInput: 540, cumulativeOutput: 60, cumulativeCached: 200 }),
  ]);
  assert.equal(result.requestCount, 3);
  assert.equal(result.sessionTotal, 600);
  assert.equal(result.sessionInput, 540);
  assert.equal(result.sessionCached, 200);
  assert.equal(result.sessionOutput, 60);
  assert.equal(result.cumulativeResetCount, 0);
});

test("F1-2 new-only：token_usage_record 统计与旧格式一致", () => {
  writeLines([
    usage("2026-09-17T11:02:01.000Z", "n1", { input: 90, output: 30, cached: 0, total: 120, threadTotal: 120, turnTotal: 120 }),
    usage("2026-09-17T11:02:02.000Z", "n2", { input: 270, output: 30, cached: 100, total: 300, threadTotal: 300, turnTotal: 300 }),
    usage("2026-09-17T11:02:03.000Z", "n3", { input: 540, output: 60, cached: 200, total: 600, threadTotal: 600, turnTotal: 600 }),
  ]);
  const result = stats.buildStats(new stats.IncrementalRolloutParser(file).readAll(), { retainRequests: false });
  assert.equal(result.requestCount, 3);
  assert.equal(result.sessionTotal, 600);
  assert.equal(result.cumulativeResetCount, 0);
});

test("F1-3 旧→新（升版）：旧格式累计不被丢弃", () => {
  const result = fixtureStats([
    tokenCount("2026-09-17T11:03:01.000Z", { total: 1000000, cumulativeInput: 990000, cumulativeOutput: 10000, cumulativeCached: 0 }),
    usage("2026-09-17T11:03:02.000Z", "m1", { input: 40, output: 10, cached: 0, total: 50, threadTotal: 50, turnTotal: 50 }),
  ]);
  assert.equal(result.requestCount, 2);
  assert.equal(result.sessionTotal, 1000050, "旧格式 1,000,000 必须保留并与新格式相加");
});

test("F1-4 新→旧（回退）：不双计，取归一化终值", () => {
  const result = fixtureStats([
    usage("2026-09-17T11:04:01.000Z", "m2", { input: 540, output: 60, cached: 0, total: 600, threadTotal: 600, turnTotal: 600 }),
    tokenCount("2026-09-17T11:04:02.000Z", { total: 1000000, cumulativeInput: 990000, cumulativeOutput: 10000, cumulativeCached: 0 }),
  ]);
  assert.equal(result.sessionTotal, 1000000);
  assert.equal(result.requestCount, 2);
});

test("F1-5 混合 + 压缩重置：累计下降按 reset 语义处理", () => {
  const result = fixtureStats([
    usage("2026-09-17T11:05:01.000Z", "c1", { input: 540, output: 60, cached: 0, total: 600, threadTotal: 600, turnTotal: 600 }),
    usage("2026-09-17T11:05:02.000Z", "c2", { input: 50, output: 10, cached: 0, total: 60, threadTotal: 60, turnTotal: 60 }),
    tokenCount("2026-09-17T11:05:03.000Z", { total: 260, cumulativeInput: 200, cumulativeOutput: 60, cumulativeCached: 0 }),
  ]);
  assert.equal(result.sessionTotal, 860, "600 + (60 重置后基线上再增长到 260)");
  // 线程累计（600→60）与轮次累计（600→60）各记一次重置，故为 2。
  assert.equal(result.cumulativeResetCount, 2);
});

test("F1-6 混合 + 尾部截断：按新基线重新统计", () => {
  const parser = new stats.IncrementalRolloutParser(file);
  writeLines([tokenCount("2026-09-17T11:06:01.000Z", { total: 600, cumulativeInput: 540, cumulativeOutput: 60, cumulativeCached: 0 })]);
  let parsed = parser.readNew();
  assert.equal(stats.buildStats(parsed, { retainRequests: false }).sessionTotal, 600);

  writeLines([usage("2026-09-17T11:06:02.000Z", "t1", { input: 40, output: 10, cached: 0, total: 50, threadTotal: 50, turnTotal: 50 })]);
  parsed = parser.readNew();
  const result = stats.buildStats(parsed, { retainRequests: false });
  assert.equal(result.sessionTotal, 50, "文件被截断重建后只统计新内容");
  assert.equal(result.cumulativeResetCount, 0);
});

test("F1-7 乱序：结果与事件顺序无关", () => {
  const legacy = tokenCount("2026-09-17T11:07:01.000Z", { total: 600, cumulativeInput: 540, cumulativeOutput: 60, cumulativeCached: 0 });
  const modern = usage("2026-09-17T11:07:02.000Z", "o1", { input: 40, output: 10, cached: 0, total: 50, threadTotal: 650, turnTotal: 50 });
  const forward = fixtureStats([legacy, modern]);
  const backward = fixtureStats([modern, legacy]);
  assert.equal(forward.sessionTotal, backward.sessionTotal);
  assert.equal(forward.requestCount, backward.requestCount);
  assert.equal(forward.cumulativeResetCount, backward.cumulativeResetCount);
});

test("F1-8 重复事件：同 id 与同内容重复都只算一次，上升即接续不相加", () => {
  const first = usage("2026-09-17T11:08:01.000Z", "r1", {
    input: 100, output: 20, cached: 0, total: 120,
    threadInput: 100, threadOutput: 20, threadCached: 0, threadTotal: 120,
    turnTotal: 120,
  });
  const legacy = tokenCount("2026-09-17T11:08:02.000Z", {
    input: 100, output: 20, cached: 0, total: 120,
    cumulativeInput: 100, cumulativeOutput: 20, cumulativeCached: 0,
  });
  const second = usage("2026-09-17T11:08:03.000Z", "r2", {
    input: 40, output: 10, cached: 0, total: 50,
    threadInput: 150, threadOutput: 20, threadCached: 0, threadTotal: 170,
    turnTotal: 50, turnId: "turn-2",
  });
  const result = fixtureStats([first, first, legacy, legacy, second]);
  assert.equal(result.requestCount, 2, "r1（含 legacy 回声）算一次、r2 算一次；重复事件不重复计数");
  // 推导：r1 累计 120 → r2 累计 170 是上升 = 接续，只把增量记进总量，所以是 170；
  // 不是 50（r2 本轮）+ 120（legacy 累计）这种相加。legacy 120 与 r1 内容相同 → 回声丢弃。
  assert.equal(result.sessionTotal, 170);
  assert.equal(result.cumulativeResetCount, 0, "r2 属于新回合 turn-2，轮次累计从头计，不构成重置");
});

test("F1-9A 同时间戳、500 的 key 全新：两次独立请求按累加式合并", () => {
  const stamp = "2026-09-17T11:09:01.000Z";
  const result = fixtureStats([
    tokenCount(stamp, { total: 1000, cumulativeInput: 900, cumulativeOutput: 100, cumulativeCached: 0 }),
    usage(stamp, "fresh-500", { input: 450, output: 50, cached: 0, total: 500, threadTotal: 500, turnTotal: 500 }),
  ]);
  assert.equal(result.requestCount, 2, "1000 与 500 是两个不同内容 key → 两次请求");
  assert.equal(result.sessionTotal, 1500, "1000 之后出现更低的 500 → 下降重启，按累加式 1000 + 500");
  assert.equal(result.cumulativeResetCount, 1);
  assert.equal(result.formatConflictCount, 1, "同 ts 但数值不同 → 真冲突（本机真实会话实测为 0）");
});

test("F1-9B 同时间戳、500 的 key 已出现：内容回声不重复计数", () => {
  const stamp = "2026-09-17T11:09:11.000Z";
  const result = fixtureStats([
    usage("2026-09-17T11:09:10.000Z", "seen-500", { input: 450, output: 50, cached: 0, total: 500, threadTotal: 500, turnTotal: 500 }),
    tokenCount(stamp, { total: 1000, cumulativeInput: 900, cumulativeOutput: 100, cumulativeCached: 0 }),
    usage(stamp, "echo-500", { input: 450, output: 50, cached: 0, total: 500, threadTotal: 500, turnTotal: 500 }),
  ]);
  assert.equal(result.requestCount, 2, "500 的 key 已出现 → 同一请求只算一次，加 legacy 的 1000 共两次");
  assert.equal(result.sessionTotal, 1000, "500 → 1000 全程上升，不触发累加");
  assert.equal(result.cumulativeResetCount, 0);
});

// ---- 双写配对（同一次请求被两代格式各写一条）----

function dualWritePair(baseTs, id, { input, output, cached, cumulative }) {
  const record = usage(new Date(baseTs).toISOString(), id, {
    input,
    output,
    cached,
    total: input + output,
    turnTotal: cumulative,
    threadTotal: cumulative,
  });
  // 同一次请求在 legacy 侧：last_token_usage 必须与本体同值（真实日志即如此），
  // 否则内容 key（线程累计|本轮量）对不上，会被判成 unique。
  const count = tokenCount(new Date(baseTs + 300).toISOString(), {
    input,
    output,
    cached,
    total: cumulative,
    cumulativeInput: input,
    cumulativeCached: cached,
    cumulativeOutput: output,
  });
  return [record, count];
}

test("F1-10 标准双写：同一次请求只算一次", () => {
  const base = Date.parse("2026-09-17T12:10:00.000Z");
  const result = fixtureStats(dualWritePair(base, "dw-1", { input: 100, output: 20, cached: 40, cumulative: 120 }));
  assert.equal(result.requestCount, 1, "同请求双写必须只计一次");
  assert.equal(result.sessionTotal, 120);
  assert.equal(result.formatConflictCount, 0);
});

test("F1-11 双写 + 压缩重置：计数不翻倍且重置记账正确", () => {
  const base = Date.parse("2026-09-17T12:11:00.000Z");
  const lines = [
    ...dualWritePair(base, "dw-2", { input: 540, output: 60, cached: 0, cumulative: 600 }),
    ...dualWritePair(base + 4000, "dw-3", { input: 50, output: 10, cached: 0, cumulative: 60 }),
  ];
  const result = fixtureStats(lines);
  assert.equal(result.requestCount, 2, "两次请求，不能被双写放大成 4");
  assert.equal(result.sessionTotal, 660);
  // 线程累计与轮次累计各记一次重置
  assert.equal(result.cumulativeResetCount, 2);
});

test("F1-12 双写 + 尾部截断：重建后仍只按请求计一次", () => {
  const base = Date.parse("2026-09-17T12:12:00.000Z");
  const parser = new stats.IncrementalRolloutParser(file);
  writeLines(dualWritePair(base, "dw-4", { input: 100, output: 20, cached: 0, cumulative: 120 }));
  let parsed = parser.readNew();
  assert.equal(stats.buildStats(parsed, { retainRequests: false }).requestCount, 1);

  writeLines(dualWritePair(base + 8000, "dw-5", { input: 50, output: 10, cached: 0, cumulative: 60 }));
  parsed = parser.readNew();
  const result = stats.buildStats(parsed, { retainRequests: false });
  assert.equal(result.requestCount, 1, "截断重建后只统计新内容且不翻倍");
  assert.equal(result.sessionTotal, 60);
});

// ---- R3 重写后的身份判定用例（身份 = 内容恒等 + 已见 key 记忆；时间只用于 echoStats 滞后统计）----

test("F1-13 错峰回声：同内容晚到仍只算一次请求，且只进回声统计", () => {
  const base = Date.parse("2026-09-17T13:13:00.000Z");
  const result = fixtureStats([
    usage(new Date(base).toISOString(), "echo-1", { input: 100, output: 20, cached: 0, total: 120, threadTotal: 120, turnTotal: 120 }),
    tokenCount(new Date(base + 12000).toISOString(), {
      input: 100, output: 20, cached: 0, total: 120,
      cumulativeInput: 100, cumulativeOutput: 20, cumulativeCached: 0,
    }),
  ]);
  assert.equal(result.requestCount, 1, "12 秒后的同内容 legacy 事件是同一次请求的回声，不新增请求");
  assert.equal(result.sessionTotal, 120);
  assert.equal(result.echoStats.total, 1, "回声计入 echoStats.total（会话级）");
  assert.equal(result.echoStats.thresholdMs, 60000, "健康度阈值 60 秒");
  assert.equal(result.echoStats.overThreshold, 0, "12 秒未超过 60 秒阈值 → 噪声，不打日志");
  assert.equal(result.formatConflictCount, 0, "同内容不是真冲突（真冲突 = 同 response_id 或同 ts 但数值不同）");
});

test("F1-14 legacy 落后一拍的 replay：同 key 回声不触发下降累加", () => {
  const base = Date.parse("2026-09-17T14:14:00.000Z");
  const at = (offset) => new Date(base + offset).toISOString();
  // 每条 legacy 的 last_token_usage 与对应本体同值（本轮 600），才能按内容 key 一对一认领。
  const legacyAt = (offset, thread) => tokenCount(at(offset), {
    input: 540,
    output: 60,
    cached: 0,
    total: thread,
    cumulativeInput: thread - 60,
    cumulativeOutput: 60,
    cumulativeCached: 0,
  });
  const result = fixtureStats([
    usage(at(0), "rp-1", { input: 540, output: 60, cached: 0, total: 600, threadTotal: 600, turnTotal: 600 }),
    usage(at(1000), "rp-2", { input: 540, output: 60, cached: 0, total: 600, threadTotal: 1200, turnTotal: 1200 }),
    usage(at(2000), "rp-3", { input: 540, output: 60, cached: 0, total: 600, threadTotal: 1800, turnTotal: 1800 }),
    legacyAt(30000, 600),
    legacyAt(31000, 600),
    legacyAt(32000, 1200),
    legacyAt(33000, 1200),
  ]);
  assert.equal(result.requestCount, 3, "落后的 legacy 回声与重放都不新增请求");
  assert.equal(result.sessionTotal, 1800, "replay 不得触发下降累加（旧实现会算成 3300）");
  assert.equal(result.echoStats.total, 2, "两条首见 legacy 各自认领一具本体 → echo");
  assert.equal(result.replayStats.count, 2, "同 key 本体已被认领的后来者 → replay（不计入 echoStats）");
});

test("F1-15 双写段 → 单格式段衔接：段间按内容接续，不重复计数", () => {
  const base = Date.parse("2026-09-17T15:15:00.000Z");
  const result = fixtureStats([
    ...dualWritePair(base, "mix-1", { input: 540, output: 60, cached: 0, cumulative: 600 }),
    ...dualWritePair(base + 4000, "mix-2", { input: 540, output: 60, cached: 0, cumulative: 1200 }),
    tokenCount(new Date(base + 8000).toISOString(), { total: 1800, cumulativeInput: 1620, cumulativeOutput: 180, cumulativeCached: 0 }),
  ]);
  assert.equal(result.requestCount, 3, "两次双写各算一次 + 单格式段一次");
  assert.equal(result.sessionTotal, 1800);
});

test("F1-16 双写中途升降版：双写段 → 仅 legacy 段 → 双写段 → 仅新格式段", () => {
  const base = Date.parse("2026-09-17T16:16:00.000Z");
  const result = fixtureStats([
    ...dualWritePair(base, "seg-1", { input: 540, output: 60, cached: 0, cumulative: 600 }),
    tokenCount(new Date(base + 4000).toISOString(), { total: 1200, cumulativeInput: 1080, cumulativeOutput: 120, cumulativeCached: 0 }),
    tokenCount(new Date(base + 8000).toISOString(), { total: 1800, cumulativeInput: 1620, cumulativeOutput: 180, cumulativeCached: 0 }),
    ...dualWritePair(base + 12000, "seg-4", { input: 540, output: 60, cached: 0, cumulative: 2400 }),
    usage(new Date(base + 16000).toISOString(), "seg-5", { input: 540, output: 60, cached: 0, total: 600, threadTotal: 3000, turnTotal: 3000 }),
  ]);
  assert.equal(result.requestCount, 5, "双写去重后按段统计：1 + 2 + 1 + 1");
  assert.equal(result.sessionTotal, 3000);
});

test("F1-17 降版重启：新格式 600 → legacy 50（下降 + 新 key）按累加式合并", () => {
  const result = fixtureStats([
    usage("2026-09-17T17:17:01.000Z", "down-1", { input: 540, output: 60, cached: 0, total: 600, threadTotal: 600, turnTotal: 600 }),
    tokenCount("2026-09-17T17:17:02.000Z", { total: 50, cumulativeInput: 40, cumulativeOutput: 10, cumulativeCached: 0 }),
  ]);
  assert.equal(result.requestCount, 2);
  assert.equal(result.sessionTotal, 650, "600 之后出现更低的 50 → 累加式 600 + 50");
  assert.equal(result.cumulativeResetCount, 1);
});

// ---- echoStats（错峰回声健康度）与真冲突（同 response_id / 同 ts 数值不同）----

test("F1-18 超阈值回声：>60s 只进 overThreshold 与 top-3，不影响请求数与总量", () => {
  const base = Date.parse("2026-09-17T18:18:00.000Z");
  const lateTs = new Date(base + 90000).toISOString();
  const result = fixtureStats([
    usage(new Date(base).toISOString(), "late-1", { input: 100, output: 20, cached: 0, total: 120, threadTotal: 120, turnTotal: 120 }),
    tokenCount(lateTs, {
      input: 100, output: 20, cached: 0, total: 120,
      cumulativeInput: 100, cumulativeOutput: 20, cumulativeCached: 0,
    }),
  ]);
  assert.equal(result.requestCount, 1, "超阈值回声仍只算一次请求");
  assert.equal(result.sessionTotal, 120);
  assert.equal(result.echoStats.overThreshold, 1, "90 秒 > 60 秒阈值 → 计入信号");
  assert.equal(result.echoStats.topLag.length, 1, "top-3 只收集超阈值回声");
  assert.equal(result.echoStats.topLag[0].ts, lateTs, "top-3 记录回声自身的时间戳，供日志使用");
  assert.equal(result.formatConflictCount, 0, "超阈值回声不是真冲突");
});

test("F1-19 双写段内 legacy-only：内容 key 全新的 legacy 记录补录为独立请求", () => {
  const base = Date.parse("2026-09-17T19:19:00.000Z");
  const result = fixtureStats([
    ...dualWritePair(base, "segl-1", { input: 540, output: 60, cached: 0, cumulative: 600 }),
    tokenCount(new Date(base + 2000).toISOString(), { total: 900, cumulativeInput: 800, cumulativeOutput: 100, cumulativeCached: 0 }),
    ...dualWritePair(base + 4000, "segl-2", { input: 540, output: 60, cached: 0, cumulative: 1200 }),
  ]);
  assert.equal(result.requestCount, 3, "两次双写各算一次 + 段内 legacy-only 补录一次");
  assert.equal(result.sessionTotal, 1200, "600 → 900 → 1200 属于同一条累计链（接续，不重复相加）");
});

test("F1-20 真冲突：同 response_id 但数值不同 → formatConflictCount 记 1", () => {
  const result = fixtureStats([
    usage("2026-09-17T20:20:01.000Z", "dup-id", { input: 100, output: 20, cached: 0, total: 120, threadTotal: 120, turnTotal: 120 }),
    usage("2026-09-17T20:20:02.000Z", "dup-id", { input: 100, output: 20, cached: 0, total: 120, threadTotal: 200, turnTotal: 120 }),
  ]);
  assert.equal(result.formatConflictCount, 1, "同 response_id 但累计数值不同 → 真冲突（本机真实会话实测为 0）");
  assert.equal(result.requestCount, 1, "同一 response_id 只算一次请求");
  assert.equal(result.sessionTotal, 120, "后一条被作为重复丢弃，不参与累计");
});

// ---- 一对一认领（echo / replay / unique）----

test("F1-21 一对一认领：echo 计入、replay 单列、unique 才补录为请求", () => {
  const result = fixtureStats([
    usage("2026-09-17T21:21:01.000Z", "claim-1", {
      input: 60, output: 40, cached: 0, total: 100,
      threadInput: 60, threadOutput: 40, threadCached: 0, threadTotal: 100, turnTotal: 100,
    }),
    usage("2026-09-17T21:21:02.000Z", "claim-2", {
      input: 120, output: 80, cached: 0, total: 200,
      threadInput: 150, threadOutput: 50, threadCached: 0, threadTotal: 200, turnTotal: 200,
      turnId: "turn-2",
    }),
    // 同内容 key（100|100）两次：第一次认领本体 → echo；第二次本体已被认领 → replay。
    tokenCount("2026-09-17T21:21:03.000Z", { input: 60, output: 40, cached: 0, total: 100, cumulativeInput: 60, cumulativeOutput: 40, cumulativeCached: 0 }),
    tokenCount("2026-09-17T21:21:04.000Z", { input: 60, output: 40, cached: 0, total: 100, cumulativeInput: 60, cumulativeOutput: 40, cumulativeCached: 0 }),
    // 新格式里没有 300|300 → unique，作为独立请求补录。
    tokenCount("2026-09-17T21:21:05.000Z", { input: 200, output: 100, cached: 0, total: 300, cumulativeInput: 200, cumulativeOutput: 100, cumulativeCached: 0 }),
  ]);
  assert.equal(result.echoStats.total, 1, "首见 legacy 认领一具本体 → echo");
  assert.equal(result.legacyStats.claimedModern, result.echoStats.total, "不变量：echo 计数 = 被认领的本体数");
  assert.equal(result.replayStats.count, 1, "本体已被认领的后来者 → replay");
  assert.equal(result.uniqueStats.count, 1, "新格式里没有该内容 key → unique");
  assert.equal(
    result.echoStats.total + result.replayStats.count + result.uniqueStats.count,
    result.legacyStats.deduped,
    "不变量：echo + replay + unique = legacy 去重后总数",
  );
  assert.equal(result.requestCount, 3, "本体 2 条（各计一次）+ unique 补录 1 条");
  assert.equal(result.sessionTotal, 300, "100 → 200 → 300 同一条累计链");
  assert.equal(result.formatConflictCount, 0);
});

test("F1-22 unique 自身重复：同内容 key 无本体时只补录一次", () => {
  const result = fixtureStats([
    usage("2026-09-17T22:22:01.000Z", "solo-1", {
      input: 60, output: 40, cached: 0, total: 100,
      threadInput: 60, threadOutput: 40, threadCached: 0, threadTotal: 100, turnTotal: 100,
    }),
    tokenCount("2026-09-17T22:22:02.000Z", { input: 200, output: 100, cached: 0, total: 300, cumulativeInput: 200, cumulativeOutput: 100, cumulativeCached: 0 }),
    tokenCount("2026-09-17T22:22:03.000Z", { input: 200, output: 100, cached: 0, total: 300, cumulativeInput: 200, cumulativeOutput: 100, cumulativeCached: 0 }),
  ]);
  assert.equal(result.uniqueStats.count, 1, "无本体的同内容重复只补录一次");
  assert.equal(result.uniqueStats.selfDuplicate, 1, "第二次记自身重复，不新增请求");
  assert.equal(result.legacyStats.raw, 2, "指纹去重后 legacy 仍是 2 条（时间戳不同）");
  assert.equal(
    result.echoStats.total + result.replayStats.count + result.uniqueStats.count,
    result.legacyStats.deduped,
    "不变量：echo + replay + unique = legacy 去重后总数（此处 = 1）",
  );
  assert.equal(result.requestCount, 2, "本体 1 条 + unique 补录 1 条");
  assert.equal(result.sessionTotal, 300);
});

// ---------------------------------------------------------------------------
// 会话分片（2026-09-19 实测：宿主在会话文件过大时切分，新文件名追加 _<分段UUID> 后缀）
// ---------------------------------------------------------------------------

test("分片：threadIdOf 剥离 _<分段UUID> 后缀并兼容旧命名", () => {
  const legacy = path.join(testRoot, "rollout-2026-09-13T21-32-09-" + threadId + ".jsonl");
  const segmented = path.join(testRoot, "rollout-2026-09-19T13-34-11-" + threadId + "_01a0b828-68a1-7662.jsonl");
  assert.equal(stats.threadIdOf(legacy), threadId);
  assert.equal(stats.threadIdOf(segmented), threadId, "分片后缀必须被剥离，否则定位不到新分片");
});

test("分片：locateThreadFiles 归组同一会话并按时间升序", () => {
  const files = [
    path.join(testRoot, "rollout-2026-09-19T13-34-11-" + threadId + "_seg2.jsonl"),
    path.join(testRoot, "rollout-2026-09-13T21-32-09-" + threadId + ".jsonl"),
    path.join(testRoot, "rollout-2026-09-18T10-00-00-other-thread.jsonl"),
  ];
  const matched = stats.locateThreadFiles(files, threadId);
  assert.equal(matched.length, 2, "只归组本会话的分片，其他会话不混入");
  assert.ok(matched[0].includes("2026-09-13"), "最早的分片排在最前");
  assert.ok(matched[1].includes("2026-09-19"), "最新的分片排在最后");
});

test("分片：mergeSegments 拼接记录、取最新上下文窗口、汇总冲突计数", () => {
  const first = {
    file: "a.jsonl", threadId, date: "2026-09-13T21-32-09",
    counts: [{}, {}], usageRecords: [{}], userMessages: [{}, {}],
    modelContextWindow: 100000, modelChanges: [{}], formatConflicts: 1,
  };
  const second = {
    file: "b.jsonl", threadId, date: "2026-09-19T13-34-11",
    counts: [{}], usageRecords: [{}], userMessages: [{}],
    modelContextWindow: 200000, modelChanges: [{}], formatConflicts: 2,
  };
  const merged = stats.mergeSegments([first, second]);
  assert.equal(merged.file, "b.jsonl", "file 取最新分片");
  assert.equal(merged.counts.length, 3);
  assert.equal(merged.usageRecords.length, 2);
  assert.equal(merged.userMessages.length, 3);
  assert.equal(merged.modelContextWindow, 200000, "上下文窗口取最新非空值");
  assert.equal(merged.formatConflicts, 3, "冲突计数跨分片求和");

  const fallback = stats.mergeSegments([first, { ...second, modelContextWindow: null }]);
  assert.equal(fallback.modelContextWindow, 100000, "最新分片缺失时回退到较早分片的值");
  assert.equal(stats.mergeSegments([null, null]), null, "全为空时返回 null");
});

test("停滞两级告警：5 分钟只预警、15 分钟降级、恢复后回到 healthy", () => {
  const session = {
    health: { status: "healthy", recoveryState: "idle" },
    lastGoodPushAt: 0,
    observedFile: "sample.jsonl",
    observedFileMtime: Date.now() - 6 * 60 * 1000, // 6 分钟：处于预警区间
    fileStallWarned: false,
    fileStallNotified: false,
  };
  const args = { target: "auto" };
  const parsed = { counts: [{}] };

  const warned = stats.nextWatchHealth(args, session, parsed, "thread-x", {});
  assert.equal(warned.status, "healthy", "6 分钟只写日志、不降级面板");
  assert.equal(session.fileStallWarned, true, "一级预警标志已记录");
  assert.equal(session.fileStallNotified, false, "二级降级尚未触发");

  session.observedFileMtime = Date.now() - 16 * 60 * 1000;
  const degraded = stats.nextWatchHealth(args, session, parsed, "thread-x", {});
  assert.equal(degraded.status, "stale-data", "超过 15 分钟降级为 stale-data");
  assert.equal(session.fileStallNotified, true);

  session.observedFileMtime = Date.now();
  const recovered = stats.nextWatchHealth(args, session, parsed, "thread-x", {});
  assert.equal(recovered.status, "healthy", "文件恢复更新后回到 healthy");
  assert.equal(session.fileStallWarned, false, "预警标志复位");
  assert.equal(session.fileStallNotified, false, "降级标志复位");
});

test("定位诊断：findSuspectFiles 识别「疑似本会话但未被识别」的文件", () => {
  const realThreadId = "01a0b828-68a1-7662-af38-5e3643265673";
  const files = [
    path.join(testRoot, "rollout-2026-09-19T13-34-11-" + realThreadId + ".jsonl"),
    path.join(testRoot, "rollout-2026-09-19T14-00-00-01a0b828-68a1-weird-suffix.jsonl"),
    path.join(testRoot, "rollout-2026-09-19T15-00-00-ffffffff-0000-0000-0000-000000000000.jsonl"),
  ];
  const suspects = stats.findSuspectFiles(files, realThreadId);
  assert.equal(suspects.length, 1, "只命中含本会话前缀、却未被识别的文件");
  assert.ok(suspects[0].includes("weird-suffix"));
  assert.equal(stats.findSuspectFiles([], realThreadId).length, 0);
});

// ---- 方案 B fixture：统一轮次归属（turn_context 为权威来源）----

// 宿主逐轮写出 turn_context，payload.turn_id 是该轮的权威标识。
function turnContext(timestamp, turnId, ordinal) {
  return JSON.stringify({
    timestamp,
    ...(Number.isFinite(ordinal) ? { ordinal } : {}),
    type: "turn_context",
    payload: { turn_id: turnId, root_turn_id: turnId, model_context_window: 1000000 },
  });
}

function readStats() {
  return stats.buildStats(new stats.IncrementalRolloutParser(file).readAll(), { retainRequests: true });
}

test("B-1 轮次清单：轮数由 turn_context 决定，当前轮 = 最后一轮", () => {
  writeLines([
    turnContext("2026-09-17T12:01:00.000Z", "T-A", 10),
    usage("2026-09-17T12:01:01.000Z", "r1", { turnId: "T-A", total: 100, turnTotal: 100, threadTotal: 100 }),
    turnContext("2026-09-17T12:02:00.000Z", "T-B", 20),
    usage("2026-09-17T12:02:01.000Z", "r2", { turnId: "T-B", total: 200, turnTotal: 200, threadTotal: 300 }),
    turnContext("2026-09-17T12:03:00.000Z", "T-C", 30),
    usage("2026-09-17T12:03:01.000Z", "r3", { turnId: "T-C", total: 300, turnTotal: 300, threadTotal: 600 }),
  ]);
  const result = readStats();
  const payload = stats.payloadFor(result);
  assert.equal(result.turns.length, 3, "轮数 = turn_context 数");
  assert.equal(payload.turnTotalCount, 3);
  assert.equal(payload.currentTurnIndex, 3, "当前轮序号 = 3");
  assert.equal(payload.turnTotal, 300, "当前轮来自 T-C 的轮累计");
  assert.equal(result.turns[0].start, "2026-09-17T12:01:00.000Z", "轮开始时间取自 turn_context");
  assert.equal(result.turns[0].total, 100, "第 1 轮 = T-A 的轮累计");
  assert.equal(result.turns[1].total, 200, "第 2 轮 = T-B 的轮累计");
  assert.equal(result.turns.at(-1).total, 300, "最后一轮 = T-C 的轮累计");
});

test("B-2 双写：同一轮的现代与 legacy 记录落在同一个轮对象上", () => {
  // 同一次请求被两代格式各写一条：legacy 的 last_token_usage 必须与本体同值，
  // 否则内容 key（线程累计|本轮量）对不上、会被判成 unique 而多算一次请求。
  writeLines([
    turnContext("2026-09-17T12:11:00.000Z", "T-A", 10),
    usage("2026-09-17T12:11:01.000Z", "dw-b2", {
      turnId: "T-A", input: 100, output: 20, cached: 80, total: 120,
      turnTotal: 120, threadTotal: 120, threadInput: 100, threadOutput: 20, threadCached: 80,
    }),
    tokenCount("2026-09-17T12:11:01.300Z", {
      input: 100, output: 20, cached: 80, total: 120,
      cumulativeInput: 100, cumulativeCached: 80, cumulativeOutput: 20,
    }),
  ]);
  const result = readStats();
  assert.equal(result.turns.length, 1, "双写不额外产生一轮");
  assert.equal(result.requestCount, 1, "回声不重复计请求");
  assert.equal(result.turns[0].requestCount, 1, "该轮只有一条被计数的记录");
  assert.equal(result.turns[0].total, 120, "轮累计取现代格式的轮累计");
});

test("B-3 legacy 记录按时间窗落到所属轮（原实现会新建填充轮）", () => {
  writeLines([
    user("2026-09-17T12:20:01.000Z"),
    user("2026-09-17T12:20:02.000Z"),
    user("2026-09-17T12:20:03.000Z"),
    turnContext("2026-09-17T12:21:00.000Z", "T-A", 10),
    usage("2026-09-17T12:21:01.000Z", "r1", { turnId: "T-A", total: 100, turnTotal: 100, threadTotal: 100 }),
    turnContext("2026-09-17T12:22:00.000Z", "T-B", 20),
    usage("2026-09-17T12:22:01.000Z", "r2", { turnId: "T-B", total: 200, turnTotal: 200, threadTotal: 300 }),
    tokenCount("2026-09-17T12:22:30.000Z", {
      total: 320, cumulativeInput: 300, cumulativeOutput: 20, cumulativeCached: 120,
    }),
  ]);
  const result = readStats();
  assert.equal(result.turns.length, 2, "不再按用户消息序号新建填充轮");
  assert.equal(result.turns[0].requestCount, 1, "T-A 只收到 r1");
  assert.equal(result.turns[1].requestCount, 2, "T-B 收到 r2 与无 turn_id 的 legacy 记录");
});

test("B-4 无 turn_context：退回 user_message 分界（旧日志行为不变）", () => {
  writeLines([
    user("2026-09-17T12:31:00.000Z"),
    tokenCount("2026-09-17T12:31:01.000Z", { total: 100, cumulativeInput: 90, cumulativeOutput: 10, cumulativeCached: 0 }),
    user("2026-09-17T12:32:00.000Z"),
    tokenCount("2026-09-17T12:32:01.000Z", { total: 300, cumulativeInput: 270, cumulativeOutput: 30, cumulativeCached: 100 }),
  ]);
  const result = readStats();
  assert.equal(result.turns.length, 2, "两条用户消息 = 两轮");
  assert.equal(result.turns[0].requestCount, 1);
  assert.equal(result.turns[1].requestCount, 1);
  assert.equal(result.sessionTotal, 300);
});

test("B-5 完全没有轮次线索：退化为单轮", () => {
  writeLines([
    usage("2026-09-17T12:41:01.000Z", "r1", { turnId: "", total: 100, turnTotal: 100, threadTotal: 100 }),
    usage("2026-09-17T12:41:02.000Z", "r2", { turnId: "", total: 200, turnTotal: 200, threadTotal: 300 }),
  ]);
  const result = readStats();
  assert.equal(result.turns.length, 1, "没有任何线索时只有一轮");
  assert.equal(result.turns[0].requestCount, 2);
  assert.equal(result.sessionTotal, 300);
});

test("B-6 分片合并：turn_context 跨分片归并后轮数与顺序正确", () => {
  const base = (turnId, ts, ordinal) => ({ ts, ordinal, turnId });
  const partA = {
    file, threadId, date: "2026-09-17T12-00-00",
    counts: [], usageRecords: [], userMessages: [],
    turnContexts: [base("T-A", "2026-09-17T12:51:00.000Z", 10)],
    modelContextWindow: 1000000, modelChanges: [], formatConflicts: 0,
  };
  const partB = {
    file, threadId, date: "2026-09-17T13-00-00",
    counts: [], usageRecords: [
      { ts: "2026-09-17T12:52:01.000Z", ordinal: 12, turnId: "T-B", responseId: "r2", model: null,
        input: 10, output: 3, cached: 2, total: 200,
        turnUsage: { input: 10, output: 3, cached: 2, total: 200 },
        threadUsage: { input: 10, output: 3, cached: 2, total: 200 } },
    ],
    userMessages: [],
    turnContexts: [base("T-B", "2026-09-17T12:52:00.000Z", 11)],
    modelContextWindow: 1000000, modelChanges: [], formatConflicts: 0,
  };
  const merged = stats.mergeSegments([partA, partB]);
  assert.equal(merged.turnContexts.length, 2, "两段 turn_context 合并");
  const result = stats.buildStats(merged, { retainRequests: true });
  assert.equal(result.turns.length, 2, "合并后两轮");
  assert.equal(result.turns[0].start, "2026-09-17T12:51:00.000Z", "第 1 轮开始时间来自 T-A");
  assert.equal(result.turns[1].start, "2026-09-17T12:52:00.000Z", "第 2 轮开始时间来自 T-B");
});

test("B-7 回归锁：混排后 currentTurn 指向真实当前轮（原 bug 会让它变成填充空轮）", () => {
  writeLines([
    user("2026-09-17T13:00:01.000Z"),
    user("2026-09-17T13:00:02.000Z"),
    user("2026-09-17T13:00:03.000Z"),
    turnContext("2026-09-17T13:01:00.000Z", "T-A", 10),
    usage("2026-09-17T13:01:01.000Z", "r1", { turnId: "T-A", total: 100, turnTotal: 100, threadTotal: 100 }),
    turnContext("2026-09-17T13:02:00.000Z", "T-B", 20),
    usage("2026-09-17T13:02:01.000Z", "r2", { turnId: "T-B", total: 200, turnTotal: 200, threadTotal: 300 }),
    tokenCount("2026-09-17T13:02:30.000Z", {
      total: 320, cumulativeInput: 300, cumulativeOutput: 20, cumulativeCached: 120,
    }),
  ]);
  const result = readStats();
  const payload = stats.payloadFor(result);
  assert.equal(result.turns.length, 2, "原实现会因用户消息序号而多出填充轮");
  assert.equal(payload.turnTotalCount, 2);
  assert.equal(payload.currentTurnIndex, 2, "当前轮 = 真实第 2 轮");
  assert.equal(payload.turnTotal, 200, "当前轮数字来自 T-B 的轮累计");
  assert.equal(payload.turnInput, 10, "当前轮输入不为 0");
  assert.equal(result.turns[1].requestCount, 2);
});

test("B-8 本轮平均速度：Σ本轮输出 ÷ Σ本轮生成耗时（与 lastRequestTps 单条口径并列）", () => {
  const parsed = {
    file,
    threadId,
    date: "2026-09-17T14-00-00",
    modelContextWindow: 1000000,
    userMessages: [],
    turnContexts: [{ ts: "2026-09-17T14:00:00.000Z", ordinal: 1, turnId: "T-A" }],
    counts: [],
    usageRecords: [
      {
        ts: "2026-09-17T14:00:01.000Z", ordinal: 2, genMs: 1000, turnId: "T-A", responseId: "r1", model: null,
        input: 100, output: 100, cached: 0, total: 100,
        turnUsage: { input: 100, output: 100, cached: 0, total: 100 },
        threadUsage: { input: 100, output: 100, cached: 0, total: 100 },
      },
      {
        ts: "2026-09-17T14:00:02.000Z", ordinal: 3, genMs: 3000, turnId: "T-A", responseId: "r2", model: null,
        input: 200, output: 200, cached: 0, total: 200,
        turnUsage: { input: 200, output: 200, cached: 0, total: 200 },
        threadUsage: { input: 200, output: 200, cached: 0, total: 200 },
      },
    ],
  };
  const result = stats.buildStats(parsed);
  const payload = stats.payloadFor(result);
  assert.equal(payload.turnTps, 75, "本轮平均 = (100 + 200) / ((1000 + 3000) / 1000)");
  assert.equal(payload.lastRequestTps, 200 / (3000 / 1000), "单条口径仍是最后一条请求的速度");
  assert.equal(payload.turnTotalCount, 1);
});

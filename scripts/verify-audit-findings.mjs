// 只读取证：验证第三方审计报告中的关键结论。
// 不修改任何文件；只输出结构化结论与数值。
// 用法：node scripts/verify-audit-findings.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
process.env.CCM_TOKENS_AS_MODULE = "1";

const stats = await import("../token-stats.mjs");
const report = {};

// ---- F1：混合日志格式（旧 token_count + 新 token_usage_record）----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccm-audit-f1-"));
  const file = path.join(dir, "rollout-2026-09-17T10-00-00-audit-f1.jsonl");
  const lines = [
    JSON.stringify({
      timestamp: "2026-09-17T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: {
        model_context_window: 1000000,
        last_token_usage: { input_tokens: 990000, output_tokens: 10000, cached_input_tokens: 0, total_tokens: 1000000 },
        total_token_usage: { input_tokens: 990000, output_tokens: 10000, cached_input_tokens: 0, total_tokens: 1000000 },
      } },
    }),
    JSON.stringify({
      timestamp: "2026-09-17T10:00:02.000Z",
      type: "token_usage_record",
      payload: {
        response_id: "new-format-1",
        turn_id: "turn-1",
        usage: { input_tokens: 40, output_tokens: 10, cached_input_tokens: 0, total_tokens: 50 },
        turn_token_usage: { input_tokens: 40, output_tokens: 10, cached_input_tokens: 0, total_tokens: 50 },
        thread_token_usage: { input_tokens: 40, output_tokens: 10, cached_input_tokens: 0, total_tokens: 50 },
      },
    }),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  const parsed = stats.parseFile(file);
  const result = stats.buildStats(parsed, { retainRequests: false });
  report.F1_mixed_format = {
    countsInParsed: parsed.counts.length,
    usageRecordsInParsed: parsed.usageRecords.length,
    requestCount: result.requestCount,
    sessionTotal: result.sessionTotal,
    legacyTokensDropped: parsed.counts.length > 0 && parsed.usageRecords.length > 0 && result.sessionTotal < 1000000,
  };
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- F2：上下文占用口径（对比最后一次请求的 input / total）----
{
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
  const files = walk(sessionsDir).map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs })).sort((a, b) => b.mtimeMs - a.mtimeMs);
  let lastUsage = null;
  let window = null;
  for (const entry of files) {
    const text = fs.readFileSync(entry.file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("token_usage_record") && !line.includes("model_context_window")) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const payload = event.payload || {};
      if (Number.isFinite(payload.model_context_window)) window = payload.model_context_window;
      if (payload.info && Number.isFinite(payload.info.model_context_window)) window = payload.info.model_context_window;
      if (event.type === "token_usage_record" && payload.usage) {
        lastUsage = {
          input: payload.usage.input_tokens,
          output: payload.usage.output_tokens,
          total: payload.usage.total_tokens,
        };
      }
    }
    if (lastUsage) break;
  }
  report.F2_context_used = {
    window,
    lastRequestUsage: lastUsage,
    monitorFormula: "min(lastRequest.usage.total_tokens, window)",
    monitorValue: lastUsage && window ? Math.min(lastUsage.total, window) : null,
    inputOnlyValue: lastUsage ? lastUsage.input : null,
    differenceTotalMinusInput: lastUsage ? lastUsage.total - lastUsage.input : null,
  };
}

// ---- F3：协议死代码检查 ----
{
  const protocolSource = fs.readFileSync(new URL("../protocol.mjs", import.meta.url), "utf8");
  const monitorSource = fs.readFileSync(new URL("../token-stats.mjs", import.meta.url), "utf8");
  const panelSource = fs.readFileSync(new URL("../codex-token-spend-panel.js", import.meta.url), "utf8");
  const statuses = [...protocolSource.matchAll(/^\s{2}"([a-z-]+)",$/gm)].map((match) => match[1]);
  report.F3_protocol_dead_code = {
    healthStatuses: statuses,
    statusesNeverAssigned: statuses.filter((status) => {
      const pattern = new RegExp("status: \\\"" + status + "\\\"|status = \\\"" + status + "\\\"|\\\"" + status + "\\\"");
      const assignments = monitorSource.match(new RegExp("(status|currentHealth)[^\\n]*" + status, "g")) || [];
      return status !== "healthy" && status !== "starting" && assignments.length === 0;
    }),
    outOfOrderInPayload: /outOfOrder\s*:/.test(panelSource) || /outOfOrder/.test(monitorSource.split("payloadFor")[1] || ""),
    modelSwitchRenderedInPanel: /modelSwitchCount[^\n]*textNode|modelSwitchCount[^\n]*append/.test(panelSource),
    title: "F3",
  };
}

// ---- F4：schema 三份实现 ----
{
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/payload-v2.schema.json", import.meta.url), "utf8"));
  const required = schema.required || [];
  const alwaysProduced = [
    "protocolName", "schemaVersion", "capabilities", "modelContextWindow", "requestCount",
    "sessionTotal", "sessionInput", "sessionCached", "sessionOutput", "contextUsed",
    "turnTotal", "turnInput", "turnCached", "turnOutput", "currentTurnIndex", "turns",
    "turnsTruncated", "turnTotalCount", "requestDetails", "requestDetailsTruncated",
    "requestDetailTotal", "modelSwitchCount", "cumulativeResetCount", "health", "updatedAt",
  ];
  report.F4_schema_drift = {
    requiredCount: required.length,
    alwaysProducedCount: alwaysProduced.length,
    missingFromRequired: alwaysProduced.filter((key) => !required.includes(key)),
    additionalProperties: schema.additionalProperties,
  };
}

// ---- F5：错误吞噬与日志截断 ----
{
  const monitorSource = fs.readFileSync(new URL("../token-stats.mjs", import.meta.url), "utf8");
  // guardian.ps1 已在「自启架构调整」中移除；只有文件仍存在时才检查该项，避免脚本因缺文件而中断。
  const guardianFile = new URL("../guardian.ps1", import.meta.url);
  const guardianSource = fs.existsSync(guardianFile) ? fs.readFileSync(guardianFile, "utf8") : "";
  report.F5_error_swallowing = {
    emptyCatchCount: (monitorSource.match(/catch\s*\{\s*\}/g) || []).length,
    catchWithEmptyBlockAll: (monitorSource.match(/catch\s*\([^)]*\)\s*\{\s*\}/g) || []).length,
    guardianPresent: guardianSource.length > 0,
    guardianRedirectsStdOut: /RedirectStandardOutput/.test(guardianSource),
    logTruncationRisk: /RedirectStandardOutput/.test(guardianSource),
  };
}

// ---- 资源开销：每秒固定工作 ----
{
  const monitorSource = fs.readFileSync(new URL("../token-stats.mjs", import.meta.url), "utf8");
  report.per_second_overhead = {
    rolloutFileListCacheMs: Number((monitorSource.match(/ROLLOUT_FILE_LIST_CACHE_MS = (\d+)/) || [])[1]),
    heartbeatIntervalMs: Number((monitorSource.match(/HEARTBEAT_INTERVAL_MS = (\d+)/) || [])[1]),
    fileFingerprintBytes: Number((monitorSource.match(/FILE_FINGERPRINT_BYTES = (\d+)/) || [])[1]),
    environmentSnapshotPerLoop: /monitorHealthFor\(args, \{/.test(monitorSource),
    usesFsWatch: /fs\.watch/.test(monitorSource),
  };
}

// ---- H1：README 英文版刷新间隔表述 ----
{
  const en = fs.readFileSync(new URL("../README.en.md", import.meta.url), "utf8");
  const firstLine = en.split(/\r?\n/).find((line) => line.includes("refresh")) || "";
  report.H1_readme_en = {
    mentionsOneSecond: /every \*\*1 second\*\*|every 1 second|1 second/i.test(firstLine),
    line: firstLine.trim().slice(0, 200),
  };
}

// ---- M2：单元测试遗留临时目录 ----
{
  const tmp = os.tmpdir();
  const leftovers = fs.readdirSync(tmp).filter((name) => name.startsWith("ccm-token-spend-test-"));
  report.M2_temp_leftovers = { count: leftovers.length, sample: leftovers.slice(0, 5) };
}

console.log(JSON.stringify(report, null, 2));

// 线程 ID 检测的实机差分探针
//
// 为什么需要它：`activeThreadId` 的核心是一段注入到 Codex 页面里执行的脚本，
// 它靠读取页面 DOM 与 React fiber 结构判断「当前是哪个对话」。这段逻辑既不在
// 单元测试覆盖范围内，也不在行为基线（命令行）覆盖范围内，只能到真实页面上跑。
//
// 用法：
//   node scripts/probe-active-thread.mjs                 # 打印当前解析结果
//   node scripts/probe-active-thread.mjs --expect <值>   # 与期望值比对，不一致则非 0 退出
//   可选：--port 9229  --target <target-id>
//
// 重构流程：改写这段脚本前先跑一次记下结果，改写后再跑一次，两次必须一致。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const sourceFile = path.join(root, "token-stats.mjs");

const argv = process.argv.slice(2);
let port = 9229;
let targetId = "";
let expected = null;
let hasExpected = false;
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--port" && Number.isInteger(Number(argv[index + 1]))) port = Number(argv[index + 1]);
  else if (argv[index] === "--target" && argv[index + 1]) targetId = String(argv[index + 1]).trim();
  else if (argv[index] === "--expect" && index + 1 < argv.length) {
    expected = argv[index + 1] === "null" ? null : String(argv[index + 1]);
    hasExpected = true;
  }
}

function fail(message) {
  console.error("探针失败: " + message);
  process.exit(1);
}

// ---- 从源码里抽出注入页面的表达式 ---------------------------------------

function constantValue(source, name) {
  const stringMatch = source.match(new RegExp("const\\s+" + name + "\\s*=\\s*\"([^\"]*)\""));
  if (stringMatch) return stringMatch[1];
  const numberMatch = source.match(new RegExp("const\\s+" + name + "\\s*=\\s*(\\d+)"));
  if (numberMatch) return Number(numberMatch[1]);
  fail("无法从源码里解析常量 " + name);
  return null;
}

function extractPageExpression(source) {
  const start = source.indexOf("async function activeThreadId(");
  if (start < 0) fail("未找到 activeThreadId");
  const end = source.indexOf("async function cdpPush(", start);
  if (end < 0) fail("未找到 activeThreadId 的结束边界");
  const body = source.slice(start, end);

  const open = body.indexOf("`");
  if (open < 0) fail("activeThreadId 里没有找到模板字符串");
  const close = body.indexOf("`", open + 1);
  if (close < 0) fail("activeThreadId 的模板字符串没有闭合");

  let expression = body.slice(open + 1, close);
  const newThread = constantValue(source, "NEW_THREAD");
  const cacheMs = constantValue(source, "ACTIVE_ID_CACHE_MS");
  // 注意：源码里这两处插值分别嵌在字符串字面量与数值表达式内部
  // （`return "${NEW_THREAD}";` / `now - cache.at < ${ACTIVE_ID_CACHE_MS}`），
  // 所以要按原文替换，不能加引号包装。
  expression = expression.replace(/\$\{NEW_THREAD\}/g, String(newThread));
  expression = expression.replace(/\$\{ACTIVE_ID_CACHE_MS\}/g, String(cacheMs));
  if (expression.includes("${")) fail("表达式中仍残留未替换的插值");
  return expression;
}

// ---- CDP 连接（与 scripts/verify-live.mjs 保持一致） ---------------------

function isEligibleTarget(target) {
  if (!target || target.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") return false;
  const url = String(target.url || "");
  if (url.includes("avatar-overlay")) return false;
  if (!url.startsWith("app://-/")) return false;
  try {
    const ws = new URL(target.webSocketDebuggerUrl);
    return ws.protocol === "ws:" && ws.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

async function loadTarget() {
  const response = await fetch("http://127.0.0.1:" + port + "/json");
  if (!response.ok) fail("CDP HTTP " + response.status);
  const targets = await response.json();
  const eligible = (Array.isArray(targets) ? targets : []).filter(isEligibleTarget);
  if (!eligible.length) fail("未找到 Codex 页面目标（端口 " + port + "）");
  if (targetId) {
    const picked = eligible.find((target) => target.id === targetId);
    if (!picked) fail("未找到指定目标 " + targetId);
    return picked;
  }
  return eligible[0];
}

function sendCommand(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => reject(new Error("CDP 评估超时")), 10000);
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (message.result && message.result.exceptionDetails) {
        reject(new Error("页面脚本异常: " + JSON.stringify(message.result.exceptionDetails).slice(0, 300)));
        return;
      }
      resolve(message.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const result = await sendCommand(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result && result.result ? result.result.value : undefined;
}

const expression = extractPageExpression(fs.readFileSync(sourceFile, "utf8"));
const target = await loadTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("CDP 连接超时")), 8000);
  ws.addEventListener("open", () => {
    clearTimeout(timer);
    resolve();
  });
  ws.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("CDP 连接失败"));
  });
});

let resolved;
try {
  resolved = await evaluate(ws, expression);
} finally {
  try {
    ws.close();
  } catch {}
}

const normalized = resolved === undefined ? null : resolved;
console.log(JSON.stringify({ resolved: normalized, expressionBytes: Buffer.byteLength(expression, "utf8") }));

if (hasExpected) {
  if (normalized !== expected) {
    console.error("不一致：期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(normalized));
    process.exit(1);
  }
  console.log("一致。");
}
process.exit(0);

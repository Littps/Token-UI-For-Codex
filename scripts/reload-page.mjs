// 重载 Codex 渲染页面，让更新后的 Codex++ 用户脚本重新注入。
// 只触发页面重载，不修改会话数据、配置或统计结果。
// 用法：node scripts/reload-page.mjs [--port 9229] [--target <target-id>]

const argv = process.argv.slice(2);
let port = 9229;
let targetId = "";
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--port" && Number.isInteger(Number(argv[index + 1]))) port = Number(argv[index + 1]);
  else if (argv[index] === "--target" && argv[index + 1]) targetId = String(argv[index + 1]).trim();
}

function eligible(target) {
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

const response = await fetch("http://127.0.0.1:" + port + "/json");
if (!response.ok) throw new Error("CDP HTTP " + response.status);
const targets = (await response.json()).filter(eligible);
if (!targets.length) throw new Error("未找到 Codex 页面目标");
const target = targetId ? targets.find((item) => item.id === targetId) : targets[0];
if (!target) throw new Error("未找到指定目标 " + targetId);
if (!targetId && targets.length > 1) {
  throw new Error("检测到多个 Codex 窗口，请显式指定 --target");
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("CDP 连接超时")), 8000);
  ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
  ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP 连接失败")); });
});

const id = 1;
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("重载指令超时")), 8000);
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id !== id) return;
    clearTimeout(timer);
    resolve();
  });
});
ws.send(JSON.stringify({ id, method: "Page.reload", params: { ignoreCache: true } }));
await done.catch(() => {});
try { ws.close(); } catch {}
console.log("已请求重载 Codex 页面: " + target.id + (target.title ? " (" + target.title + ")" : ""));

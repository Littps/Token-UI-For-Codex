// 实机验收：只读取页面状态，并在结束时自动关闭详情弹层。
// 用法：node scripts/verify-live.mjs [--port 9229] [--target <target-id>]
// 多窗口且无法唯一判断时，需要显式传入 --target。

const argv = process.argv.slice(2);
let port = 9229;
let targetId = "";
let checkRefresh = false;
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--port" && Number.isInteger(Number(argv[index + 1]))) port = Number(argv[index + 1]);
  else if (argv[index] === "--target" && argv[index + 1]) targetId = String(argv[index + 1]).trim();
  else if (argv[index] === "--refresh") checkRefresh = true;
}

function fail(message) {
  console.error("验收失败: " + message);
  process.exit(1);
}

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

async function loadTargets() {
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
  if (eligible.length > 1) {
    const list = eligible.map((target) => "  " + target.id + "  " + (target.title || "")).join("\n");
    fail("检测到多个 Codex 窗口，请显式指定 --target：\n" + list);
  }
  return eligible[0];
}

function sendCommand(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => reject(new Error("CDP 评估超时")), 8000);
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
        reject(new Error("页面脚本异常: " + JSON.stringify(message.result.exceptionDetails).slice(0, 200)));
        return;
      }
      resolve(message.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const result = await sendCommand(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result && result.result ? result.result.value : undefined;
}

const target = await loadTargets();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("CDP 连接超时")), 8000);
  ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
  ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP 连接失败")); });
});

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
}

try {
  const snapshotRaw = await evaluate(ws, `(() => {
    const root = document.getElementById('tui-native');
    const ring = document.querySelector('[aria-label*="上下文用量"], [aria-label*="上下文窗口"], [aria-label*="Context usage" i], [aria-label*="Context window" i]');
    const protocol = window.__tuiForCodexProtocol || null;
    const payload = window.__tuiForCodex || null;
    const rootRect = root ? root.getBoundingClientRect() : null;
    const ringRect = ring ? ring.getBoundingClientRect() : null;
    return JSON.stringify({
      installed: window.__tuiForCodexNativeUiInstalled === true,
      protocolName: protocol && protocol.protocolName,
      supportedSchemaVersions: protocol ? protocol.supportedSchemaVersions : null,
      payloadProtocolName: payload && payload.protocolName,
      payloadSchemaVersion: payload && payload.schemaVersion,
      payloadHealthStatus: payload && payload.health && payload.health.status,
      panelCount: document.querySelectorAll('#tui-native').length,
      styleCount: document.querySelectorAll('#tui-native-style').length,
      panelLeftOfRing: !!(rootRect && ringRect && rootRect.right <= ringRect.left + 4),
      panelRect: rootRect ? { left: Math.round(rootRect.left), right: Math.round(rootRect.right) } : null,
      ringRect: ringRect ? { left: Math.round(ringRect.left), right: Math.round(ringRect.right) } : null,
    });
  })()`);
  const snapshot = JSON.parse(snapshotRaw || "{}");

  record("协议已注册", snapshot.protocolName === "tokens-ui-for-codex", snapshot.protocolName);
  record("支持 schema v2", Array.isArray(snapshot.supportedSchemaVersions) && snapshot.supportedSchemaVersions.includes(2), snapshot.supportedSchemaVersions);
  record("统计条唯一", snapshot.panelCount === 1, snapshot.panelCount);
  record("样式表唯一", snapshot.styleCount === 1, snapshot.styleCount);
  record("统计条位于上下文圆圈左侧", snapshot.panelLeftOfRing, { panel: snapshot.panelRect, ring: snapshot.ringRect });
  record("负载协议名匹配", snapshot.payloadProtocolName === "tokens-ui-for-codex", snapshot.payloadProtocolName);
  record("负载 schema v2", snapshot.payloadSchemaVersion === 2, snapshot.payloadSchemaVersion);
  record("运行状态健康", ["healthy", "waiting-for-data", "starting"].includes(snapshot.payloadHealthStatus), snapshot.payloadHealthStatus);

  await evaluate(ws, `(() => {
    const root = document.getElementById('tui-native');
    if (!root) return 'missing';
    root.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    return 'clicked';
  })()`);
  const openRaw = await evaluate(ws, `(() => {
    const dialog = document.getElementById('tui-detail-dialog');
    const titles = dialog ? [...dialog.querySelectorAll('.tui-dialog-section-title')].map((node) => node.textContent) : [];
    const sessionSection = dialog ? dialog.querySelector('.tui-dialog-section') : null;
    const sessionLabels = sessionSection
      ? [...sessionSection.querySelectorAll('.tui-dialog-card-label')].map((node) => node.textContent)
      : [];
    return JSON.stringify({
      open: !!dialog && dialog.getAttribute('data-open') === 'true',
      sections: dialog ? dialog.querySelectorAll('.tui-dialog-section').length : 0,
      role: dialog ? dialog.getAttribute('role') : null,
      titles,
      sessionLabels,
    });
  })()`);
  const openState = JSON.parse(openRaw || "{}");
  record("左键可打开详情", openState.open === true, openState);
  record("详情分区已渲染", openState.sections >= 4, openState.sections);
  record("详情使用 dialog 语义", openState.role === "dialog", openState.role);
  record(
    "分区顺序正确",
    Array.isArray(openState.titles) && openState.titles.slice(0, 4).join(",") === "会话累计,当前提问统计,上下文使用,运行状态",
    openState.titles,
  );
  record(
    "会话累计含请求数量",
    Array.isArray(openState.sessionLabels) && openState.sessionLabels.includes("请求"),
    openState.sessionLabels,
  );

  // 键盘监听已按设计移除（Esc 不关闭弹层），因此这里不再派发 Esc，也不再有对应断言
  // （该检查已按用户决定删除：它与产品决定相反，属于陈旧断言）。
  // 收尾仍走设计好的「点击外部关闭」路径，避免把弹层打开状态留给使用者；这里不产生断言。
  await evaluate(ws, `(() => {
    if (!document.getElementById('tui-detail-dialog')) return 'no-dialog';
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
    if (document.getElementById('tui-detail-dialog')) {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    }
    return document.getElementById('tui-detail-dialog') ? 'still-open' : 'closed';
  })()`);

  if (checkRefresh) {
    const first = await evaluate(ws, "window.__tuiForCodex && window.__tuiForCodex.updatedAt");
    await new Promise((resolve) => setTimeout(resolve, 6500));
    const second = await evaluate(ws, "window.__tuiForCodex && window.__tuiForCodex.updatedAt");
    const deltaMs = Date.parse(second) - Date.parse(first);
    record(
      "每 5 秒固定刷新",
      Number.isFinite(deltaMs) && deltaMs >= 3000 && deltaMs <= 9000,
      { first, second, deltaMs },
    );
  }
} finally {
  try { ws.close(); } catch {}
}

const failed = checks.filter((check) => !check.ok);
console.log(JSON.stringify({ port, targetId: target.id, title: target.title || "", checks, failed: failed.length }, null, 2));
if (failed.length) process.exit(1);

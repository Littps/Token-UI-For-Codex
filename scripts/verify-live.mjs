// 实机验收：只读取页面状态，并在结束时自动关闭详情弹层。
// 用法：node scripts/verify-live.mjs [--port auto|<n>] [--target <target-id>]
// 多窗口且无法唯一判断时，需要显式传入 --target。

import { portArgOf, resolveCdpPort } from "./cdp-port.mjs";

const argv = process.argv.slice(2);
let targetId = "";
let checkRefresh = false;
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--target" && argv[index + 1]) targetId = String(argv[index + 1]).trim();
  else if (argv[index] === "--refresh") checkRefresh = true;
}
const port = await resolveCdpPort(portArgOf(argv));

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
  ws.addEventListener("open", () => {
    clearTimeout(timer);
    resolve();
  });
  ws.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("CDP 连接失败"));
  });
});

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
}

try {
  const snapshotRaw = await evaluate(
    ws,
    `(() => {
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
      payloadCapabilities: payload && payload.capabilities,
      payloadAuthRequired: payload && payload.authRequired,
      payloadAuthVersion: payload && payload.auth && payload.auth.v,
      payloadKeyId: payload && payload.auth && payload.auth.keyId,
      payloadNonce: payload && payload.auth && payload.auth.nonce,
      payloadSeq: payload && payload.auth && payload.auth.seq,
      payloadHasMac: !!(payload && payload.auth && /^[0-9a-f]{64}$/.test(payload.auth.mac)),
      transientKeyAbsent: !('__tuiForCodexAuthBootstrap' in window) && !('__tuiForCodexAuthKey' in window),
      payloadHealthStatus: payload && payload.health && payload.health.status,
      panelCount: document.querySelectorAll('#tui-native').length,
      styleCount: document.querySelectorAll('#tui-native-style').length,
      panelLeftOfRing: !!(rootRect && ringRect && rootRect.right <= ringRect.left + 4),
      panelRect: rootRect ? { left: Math.round(rootRect.left), right: Math.round(rootRect.right) } : null,
      ringRect: ringRect ? { left: Math.round(ringRect.left), right: Math.round(ringRect.right) } : null,
    });
  })()`,
  );
  const snapshot = JSON.parse(snapshotRaw || "{}");

  record("协议已注册", snapshot.protocolName === "tokens-ui-for-codex", snapshot.protocolName);
  record(
    "支持 schema v5",
    Array.isArray(snapshot.supportedSchemaVersions) && snapshot.supportedSchemaVersions.includes(5),
    snapshot.supportedSchemaVersions,
  );
  record("统计条唯一", snapshot.panelCount === 1, snapshot.panelCount);
  record("样式表唯一", snapshot.styleCount === 1, snapshot.styleCount);
  record("统计条位于上下文圆圈左侧", snapshot.panelLeftOfRing, { panel: snapshot.panelRect, ring: snapshot.ringRect });
  record("负载协议名匹配", snapshot.payloadProtocolName === "tokens-ui-for-codex", snapshot.payloadProtocolName);
  record("负载 schema v5", snapshot.payloadSchemaVersion === 5, snapshot.payloadSchemaVersion);
  record(
    "timing-v1 能力已注册",
    Array.isArray(snapshot.payloadCapabilities) && snapshot.payloadCapabilities.includes("timing-v1"),
    snapshot.payloadCapabilities,
  );
  record(
    "history-range-v1 能力已注册",
    Array.isArray(snapshot.payloadCapabilities) && snapshot.payloadCapabilities.includes("history-range-v1"),
    snapshot.payloadCapabilities,
  );
  record(
    "上下文估算能力已注册",
    Array.isArray(snapshot.payloadCapabilities) &&
      snapshot.payloadCapabilities.includes("context-breakdown-estimated-v1"),
    snapshot.payloadCapabilities,
  );
  record("负载要求签名", snapshot.payloadAuthRequired === true, snapshot.payloadAuthRequired);
  record("负载认证版本 v2", snapshot.payloadAuthVersion === 2, snapshot.payloadAuthVersion);
  record("负载 keyId 有效", /^[0-9a-f]{32}$/.test(snapshot.payloadKeyId || ""), snapshot.payloadKeyId);
  record("负载 nonce 有效", /^[0-9a-f]{32}$/.test(snapshot.payloadNonce || ""), snapshot.payloadNonce);
  record("负载 seq 有效", Number.isSafeInteger(snapshot.payloadSeq) && snapshot.payloadSeq >= 1, snapshot.payloadSeq);
  record("负载携带 HMAC", snapshot.payloadHasMac === true, snapshot.payloadHasMac);
  record("临时密钥已清理", snapshot.transientKeyAbsent === true, snapshot.transientKeyAbsent);
  record(
    "运行状态健康",
    ["healthy", "waiting-for-data", "starting"].includes(snapshot.payloadHealthStatus),
    snapshot.payloadHealthStatus,
  );

  await evaluate(
    ws,
    `(() => {
    const root = document.getElementById('tui-native');
    if (!root) return 'missing';
    root.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    return 'clicked';
  })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const openRaw = await evaluate(
    ws,
    `(() => {
    const payload = window.__tuiForCodex || null;
    const dialog = document.getElementById('tui-detail-dialog');
    const titles = dialog ? [...dialog.querySelectorAll('.tui-dialog-section-title')].map((node) => node.textContent) : [];
    const sessionSection = dialog ? dialog.querySelector('.tui-dialog-section') : null;
    const sessionLabels = sessionSection
      ? [...sessionSection.querySelectorAll('.tui-dialog-card-label')].map((node) => node.textContent)
      : [];
    const timingSections = dialog ? [...dialog.querySelectorAll('.tui-dialog-section')].slice(0, 2) : [];
    const timingLabels = timingSections.map((section) =>
      [...section.querySelectorAll('.tui-dialog-timing-label')].map((node) => node.textContent.trim()),
    );
    const contextSection = dialog
      ? [...dialog.querySelectorAll('.tui-dialog-section')].find(
          (section) => section.querySelector('.tui-dialog-section-title')?.textContent === '上下文使用',
        )
      : null;
    const rangeSelect = dialog ? dialog.querySelector('.tui-range-select') : null;
    const healthDot = dialog ? dialog.querySelector('.tui-dialog-health-dot') : null;
    return JSON.stringify({
      open: !!dialog && dialog.getAttribute('data-open') === 'true',
      sections: dialog ? dialog.querySelectorAll('.tui-dialog-section').length : 0,
      role: dialog ? dialog.getAttribute('role') : null,
      titles,
      sessionLabels,
      timingLabels,
      contextLegendCount: contextSection ? contextSection.querySelectorAll('.tui-context-legend-row').length : 0,
      contextText: contextSection ? contextSection.textContent : '',
      rangeValue: rangeSelect ? rangeSelect.value : null,
      rangeOptions: rangeSelect ? [...rangeSelect.options].map((option) => option.value) : [],
      rangeSummary: payload && payload.rangeSummary ? payload.rangeSummary.range : null,
      healthDotTitle: healthDot ? healthDot.getAttribute('title') : null,
      healthDotAria: healthDot ? healthDot.getAttribute('aria-label') : null,
      healthDotTabIndex: healthDot ? healthDot.getAttribute('tabindex') : null,
    });
  })()`,
  );
  const openState = JSON.parse(openRaw || "{}");
  record("左键可打开详情", openState.open === true, openState);
  record("详情分区已渲染", openState.sections >= 4, openState.sections);
  record("详情使用 dialog 语义", openState.role === "dialog", openState.role);
  record(
    "分区顺序正确",
    Array.isArray(openState.titles) &&
      openState.titles.slice(0, 4).join(",") === "统计信息,当前提问统计,上下文使用,监控操作",
    openState.titles,
  );
  record(
    "统计信息含请求数量",
    Array.isArray(openState.sessionLabels) && openState.sessionLabels.includes("请求"),
    openState.sessionLabels,
  );
  record(
    "会话与当前轮时间带存在",
    JSON.stringify(openState.timingLabels) ===
      JSON.stringify([
        ["累计处理用时", "工具累计", "平均 TTFT"],
        ["本轮总用时", "工具用时", "TTFT"],
      ]),
    openState.timingLabels,
  );
  record("上下文分类图例完整", openState.contextLegendCount === 4, openState.contextLegendCount);
  record(
    "统计范围控件可用",
    JSON.stringify(openState.rangeOptions) === JSON.stringify(["today", "3d", "7d", "30d", "all"]),
    openState.rangeOptions,
  );
  record("统计范围按需汇总", openState.rangeValue === openState.rangeSummary, {
    selected: openState.rangeValue,
    summary: openState.rangeSummary,
  });
  record(
    "健康灯错误提示可访问",
    typeof openState.healthDotTitle === "string" &&
      openState.healthDotTitle.includes("运行状态") &&
      openState.healthDotTitle.includes("错误码") &&
      typeof openState.healthDotAria === "string" &&
      openState.healthDotTabIndex === "0",
    {
      title: openState.healthDotTitle,
      aria: openState.healthDotAria,
      tabIndex: openState.healthDotTabIndex,
    },
  );
  record(
    "上下文数字不使用 K/M/B 缩写",
    !/\d(?:\.\d+)?[KMB]\b/i.test(openState.contextText || ""),
    openState.contextText,
  );

  // 键盘监听已按设计移除（Esc 不关闭弹层），因此这里不再派发 Esc，也不再有对应断言
  // （该检查已按用户决定删除：它与产品决定相反，属于陈旧断言）。
  // 收尾仍走设计好的「点击外部关闭」路径，避免把弹层打开状态留给使用者；这里不产生断言。
  await evaluate(
    ws,
    `(async () => {
    if (!document.getElementById('tui-detail-dialog')) return 'no-dialog';
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
    if (document.getElementById('tui-detail-dialog')) {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return document.getElementById('tui-detail-dialog') ? 'still-open' : 'closed';
  })()`,
  );

  if (checkRefresh) {
    const first = await evaluate(ws, "window.__tuiForCodex && window.__tuiForCodex.updatedAt");
    await new Promise((resolve) => setTimeout(resolve, 6500));
    const second = await evaluate(ws, "window.__tuiForCodex && window.__tuiForCodex.updatedAt");
    const deltaMs = Date.parse(second) - Date.parse(first);
    record("每 5 秒固定刷新", Number.isFinite(deltaMs) && deltaMs >= 3000 && deltaMs <= 9000, {
      first,
      second,
      deltaMs,
    });
  }
} finally {
  try {
    ws.close();
  } catch {}
}

const failed = checks.filter((check) => !check.ok);
console.log(
  JSON.stringify({ port, targetId: target.id, title: target.title || "", checks, failed: failed.length }, null, 2),
);
if (failed.length) process.exit(1);

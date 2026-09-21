// Tokens UI For Codex —— Codex++ 用户脚本（统计条 + 详情弹层）
// 作者：Littps · 许可：MIT · 协议：tokens-ui-for-codex（schema v2）
//
// 作用：把紧凑的 Token 统计条挂到输入区右下的「上下文用量圆圈」左侧，并提供左键单击打开的详情弹层。
// 依赖：本地监控进程 `node token-stats.mjs --watch --cdp`（默认经 127.0.0.1:9229 推送 schema v2 负载）。
// 边界：不修改 Codex 的 React bundle、不注册任何键盘监听、不读取或展示用户消息正文。
// 安装：把本文件放入 %APPDATA%\Codex++\user_scripts\ ，并在 Codex++ 中启用用户脚本。
(() => {
  "use strict";

  // The widget is inserted beside Codex's native context ring. It deliberately
  // avoids patching React internals or showing a floating panel.
  const PROTOCOL_NAME = "tokens-ui-for-codex";
  const PROTOCOL_SCHEMA_VERSION = 2;
  const PROTOCOL_CAPABILITIES = [
    "session-total",
    "current-prompt-total",
    "request-count",
    "cache-split",
    "context-usage",
    "turn-summaries",
    "request-details",
    "health-snapshot",
  ];
  window.__tuiForCodexProtocol = {
    protocolName: PROTOCOL_NAME,
    protocolVersion: PROTOCOL_SCHEMA_VERSION,
    supportedSchemaVersions: [PROTOCOL_SCHEMA_VERSION],
    capabilities: PROTOCOL_CAPABILITIES.slice(),
  };
  const INSTALL_FLAG = "__tuiForCodexNativeUiInstalled";
  if (window[INSTALL_FLAG]) return;
  window[INSTALL_FLAG] = true;

  const ROOT_ID = "tui-native";
  const STYLE_ID = "tui-native-style";
  const DIALOG_ID = "tui-detail-dialog";
  const DATA_EVENT = "tokens-ui-for-codex";
  // 跨进程契约只有这一个事件名，不保留任何历史别名。
  // 升级路径由安装器负责：注入用户脚本时会按“脚本内容”识别并停用其它历史面板脚本，
  // 页面重载后旧 DOM 自然消失，因此这里不再维护「历史元素 id」清理列表。

  // ---- 推送窗口（页面 -> 监控的单向信号）---------------------------------
  // 监控每秒读一次 <html data-tui-window>（"turns:requests"），窗口变化立刻推送。
  // 弹层关闭时只要最近 5 轮（极简负载），打开时 25 轮 + 10 条请求明细；「加载更多」每次 +50 / +20。
  const TURN_WINDOW_CLOSED = 5;
  const TURN_WINDOW_OPEN = 25;
  const TURN_WINDOW_STEP = 50;
  const REQUEST_WINDOW_CLOSED = 0;
  const REQUEST_WINDOW_OPEN = 10;
  const REQUEST_WINDOW_STEP = 20;

  const state = {
    data: null,
    dataKey: "",
    root: null,
    container: null,
    resizeObserver: null,
    mutationObserver: null,
    mountQueued: false,
    dialog: null,
    previousFocus: null,
    protocolError: "",
    // 悬浮冻结（方案甲）：指针停留在统计条上时，冻结对统计条的一切写入
    hoverFrozen: false,
    // 当前声明的推送窗口（弹层关闭 -> 极简；打开 -> 展开）
    windowTurns: TURN_WINDOW_CLOSED,
    windowRequests: REQUEST_WINDOW_CLOSED,
    // 由监控下发（方案乙）；未收到前用 Infinity，保证不误伤
    turnsLimit: Infinity,
    requestsLimit: Infinity,
    // 上一份负载的会话总量，用于识别「切换了会话」（总量回退）
    lastSessionTotal: null,
  };

  // 把当前窗口写进 <html>，等监控下一次巡检读到（最长 1 秒）后按需推送。
  function publishWindow() {
    try {
      document.documentElement.setAttribute("data-tui-window", state.windowTurns + ":" + state.windowRequests);
    } catch (e) {}
  }
  publishWindow();

  function fmtShort(value) {
    if (value == null) return "--";
    const n = Number(value);
    if (!Number.isFinite(n)) return "--";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }

  function fmtInt(value) {
    if (value == null) return "--";
    const n = Number(value);
    if (!Number.isFinite(n)) return "--";
    return n.toLocaleString("en-US");
  }

  function numberOrNull(value) {
   if (value == null) return null;
   const n = Number(value);
   return Number.isFinite(n) ? n : null;
 }

  function cacheSplit(input, cached) {
    const total = numberOrNull(input);
    const hit = numberOrNull(cached);
    if (total == null || hit == null) return { input: total, cached: null, uncached: null };
    return {
      input: total,
      cached: Math.min(total, Math.max(0, hit)),
      uncached: Math.max(0, total - Math.min(total, Math.max(0, hit))),
    };
  }

  function isNonNegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  function isNullableNonNegativeNumber(value) {
    return value == null || isNonNegativeNumber(value);
  }

  function validateIncomingPayload(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "负载不是对象" };
    if (data.protocolName !== PROTOCOL_NAME) return { ok: false, error: "统计协议名称不匹配" };
    if (data.schemaVersion !== PROTOCOL_SCHEMA_VERSION) return { ok: false, error: "统计协议版本不匹配" };
    if (!Array.isArray(data.capabilities) || !data.capabilities.includes("health-snapshot")) return { ok: false, error: "统计协议能力不匹配" };
    for (const key of ["requestCount", "turnTotal", "turnInput", "turnOutput", "currentTurnIndex", "turnTotalCount", "requestDetailTotal", "modelSwitchCount", "cumulativeResetCount"]) {
      if (!isNonNegativeNumber(data[key])) return { ok: false, error: `${key} 字段无效` };
    }
    for (const key of ["sessionTotal", "contextUsed", "modelContextWindow", "sessionInput", "sessionCached", "sessionOutput", "turnCached", "turnTps"]) {
      if (!isNullableNonNegativeNumber(data[key])) return { ok: false, error: `${key} 字段无效` };
    }
  // 这两个上限原本写成「等于监控侧上限」，形成隐藏耦合：
  // 一旦监控侧放宽上限而面板未同步，面板会拒收整个负载 → 统计条什么数字都不显示，极难排查。
  // 因此这里只拦「荒谬值」（防御异常/恶意负载），正常超限由监控侧负责截断。
  // 监控侧对应常量：MAX_TURN_SUMMARIES / MAX_REQUEST_DETAILS（改动时无需同步本行）。
  if (!Array.isArray(data.turns) || data.turns.length > 1000) return { ok: false, error: "轮次摘要超出限制" };
  if (!Array.isArray(data.requestDetails) || data.requestDetails.length > 1000) return { ok: false, error: "请求明细超出限制" };
    for (const turn of data.turns) {
      if (!turn || !Number.isInteger(turn.index) || turn.index < 1 || typeof turn.startLabel !== "string" || !isNonNegativeNumber(turn.requests)) {
        return { ok: false, error: "轮次摘要字段无效" };
      }
      for (const key of ["input", "output", "total"]) {
        if (!isNonNegativeNumber(turn[key])) return { ok: false, error: `轮次摘要 ${key} 字段无效` };
      }
      for (const key of ["cached", "uncached"]) {
        if (!isNullableNonNegativeNumber(turn[key])) return { ok: false, error: `轮次摘要 ${key} 字段无效` };
      }
    }
    for (const request of data.requestDetails) {
      if (!request || !Number.isInteger(request.index) || request.index < 1 || typeof request.time !== "string") {
        return { ok: false, error: "请求明细字段无效" };
      }
      for (const key of ["input", "cached", "uncached", "output", "total"]) {
        if (!isNullableNonNegativeNumber(request[key])) return { ok: false, error: `请求明细 ${key} 字段无效` };
      }
    }
    if (typeof data.updatedAt !== "string" || !data.updatedAt) return { ok: false, error: "更新时间无效" };
    if (data.health && typeof data.health !== "object") return { ok: false, error: "健康状态无效" };
    return { ok: true, error: "" };
  }

  function adoptData(nextData) {
    if (!nextData) {
      state.data = null;
      state.protocolError = "";
      state.dataKey = "";
      return;
    }
    const validation = validateIncomingPayload(nextData);
    state.protocolError = validation.ok ? "" : validation.error;
    state.data = validation.ok ? nextData : null;
    state.dataKey = validation.ok ? dataKeyOf(nextData) : "";
  }

  function healthLabel(health) {
    const status = health && health.status;
    const labels = {
      starting: "监控正在启动",
      healthy: "运行正常",
      "waiting-for-cdp": "等待调试通道",
      "waiting-for-page": "等待 Codex 页面",
      "waiting-for-data": "等待统计数据",
      "target-selection-required": "需要选择窗口",
      "protocol-mismatch": "协议不匹配",
      "stale-data": "数据暂未更新",
      recovering: "正在恢复",
      failed: "监控异常",
    };
    return labels[status] || "状态未知";
  }

  function percent(value, total) {
    const n = Number(value);
    const max = Number(total);
    if (!Number.isFinite(n) || !Number.isFinite(max) || max <= 0) return null;
    return Math.min(100, Math.max(0, (n / max) * 100));
  }

  function textNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function tokenText(value) {
    return value == null || !Number.isFinite(Number(value)) ? "--" : `${fmtInt(value)} tokens`;
  }

  function currentTurnOf(data) {
    if (!data) return null;
    if (Array.isArray(data.turns) && data.turns.length) {
      return data.turns[data.turns.length - 1];
    }
    return {
      index: data.currentTurnIndex || (data.turnTotal != null ? 1 : 0),
      startLabel: "当前",
      requests: data.requestCount || 0,
      input: data.turnInput,
      cached: data.turnCached,
      output: data.turnOutput,
      total: data.turnTotal,
    };
  }

  function dataKeyOf(data) {
    if (!data) return "";
    return [
      data.schemaVersion || 1,
      data.requestCount,
      data.sessionTotal,
      data.sessionInput,
      data.sessionCached,
      data.sessionOutput,
      data.contextUsed,
      data.currentTurnIndex,
      data.turnTotal,
      data.turnInput,
      data.turnCached,
      data.turnOutput,
      data.turnTotalCount,
      data.turnsTruncated,
      data.requestDetailTotal,
      data.modelSwitchCount,
      data.cumulativeResetCount,
      data.health && data.health.status,
      data.health && data.health.recoveryState,
    ].join("|");
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
/* ---- 主题 token：先用宿主变量，取不到时按深浅主题回退 ---- */
#${ROOT_ID}, #${DIALOG_ID} {
  --tui-surface: var(--color-background-primary, var(--background-primary, #ffffff));
  --tui-surface-2: var(--color-background-secondary, rgba(127, 127, 127, .08));
  --tui-surface-3: var(--color-background-tertiary, rgba(127, 127, 127, .16));
  --tui-hover: var(--color-background-hover, rgba(127, 127, 127, .12));
  --tui-border: var(--color-border, var(--border-color, rgba(127, 127, 127, .28)));
  --tui-text: var(--color-text, var(--text-primary, #1f2328));
  --tui-text-dim: var(--color-text-secondary, var(--color-text, currentColor));
  --tui-shadow: 0 16px 42px rgba(0, 0, 0, .22), 0 3px 12px rgba(0, 0, 0, .14);
  color-scheme: light;
}
/* 深色：用从 Codex 深色界面实测取到的颜色
   （主内容 #181818 / 浮层 #2d2d2d / 文字 #ffffff / 边框 rgba(255,255,255,.084)） */
#${ROOT_ID}[data-tui-theme="dark"], #${DIALOG_ID}[data-tui-theme="dark"] {
  --tui-surface: var(--color-surface-elevated-secondary, var(--color-surface, #2d2d2d));
  --tui-surface-2: var(--color-background-secondary, rgba(255, 255, 255, .08));
  --tui-surface-3: var(--color-background-tertiary, rgba(255, 255, 255, .14));
  --tui-hover: var(--color-background-hover, rgba(255, 255, 255, .08));
  --tui-border: var(--color-border, rgba(255, 255, 255, .12));
  --tui-text: var(--color-text, #ffffff);
  --tui-text-dim: var(--color-text-secondary, rgba(255, 255, 255, .65));
  --tui-shadow: 0 16px 42px rgba(0, 0, 0, .55), 0 3px 12px rgba(0, 0, 0, .38);
  color-scheme: dark;
}
#${ROOT_ID} {
  display: inline-flex;
  flex: 0 0 auto;
  min-width: 0;
  max-width: min(420px, 46vw);
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  gap: 0;
  margin: 0 4px 0 0;
  color: var(--tui-text-dim);
  font-family: inherit;
  font-size: 11px;
  line-height: 14px;
  white-space: nowrap;
  overflow: hidden;
  vertical-align: middle;
  user-select: none;
  pointer-events: auto;
  cursor: pointer;
  border-radius: 6px;
  outline: none;
  transition: background-color .12s ease, opacity .12s ease;
}
#${ROOT_ID}:hover { background: var(--tui-hover); }
#${ROOT_ID}:focus-visible {
  outline: 2px solid var(--color-accent, var(--color-primary, #6ea8fe));
  outline-offset: 2px;
}
#${ROOT_ID} .tui-native-primary,
#${ROOT_ID} .tui-native-secondary {
  display: flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${ROOT_ID} .tui-native-primary {
  color: var(--tui-text);
  font-size: 11px;
  font-weight: 500;
}
#${ROOT_ID} .tui-native-secondary {
  color: var(--tui-text-dim);
  font-size: 10px;
  line-height: 12px;
  opacity: .9;
}
#${ROOT_ID} .tui-native-metric {
  display: inline-flex;
  min-width: 0;
  align-items: baseline;
  gap: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${ROOT_ID} .tui-native-label { opacity: .72; }
#${ROOT_ID} .tui-native-value { font-variant-numeric: tabular-nums; }
#${ROOT_ID}.tui-native-compact .tui-native-label { display: none; }
#${ROOT_ID}.tui-native-compact { max-width: min(280px, 42vw); }
#${ROOT_ID}.tui-native-stale { opacity: .62; }
#${ROOT_ID}.tui-native-error { color: var(--color-danger, var(--color-text-danger, #c0392b)); }
#${DIALOG_ID} {
  position: fixed;
  z-index: 2147483000;
  display: none;
  width: min(440px, calc(100vw - 24px));
  max-height: min(560px, calc(100vh - 24px));
  flex-direction: column;
  overflow: hidden;
  color: var(--tui-text);
  background: var(--tui-surface);
  border: 1px solid var(--tui-border);
  border-radius: 12px;
  box-shadow: var(--tui-shadow);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.4;
}
#${DIALOG_ID}[data-open="true"] { display: flex; }
#${DIALOG_ID} .tui-dialog-header {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--tui-border);
}
#${DIALOG_ID} .tui-dialog-title { font-size: 14px; font-weight: 650; }
#${DIALOG_ID} .tui-dialog-subtitle {
  margin-top: 2px;
  color: var(--tui-text-dim);
  font-size: 11px;
}
#${DIALOG_ID} .tui-dialog-close {
  display: inline-flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  padding: 0;
  color: var(--color-text-secondary, currentColor);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  font-size: 18px;
  line-height: 1;
}
#${DIALOG_ID} .tui-dialog-close:hover,
#${DIALOG_ID} .tui-dialog-close:focus-visible {
  color: var(--tui-text);
  background: var(--tui-hover);
  outline: none;
}
#${DIALOG_ID} .tui-dialog-body {
  min-height: 0;
  padding: 12px 16px 16px;
  overflow: auto;
  scrollbar-width: thin;
}
#${DIALOG_ID} .tui-dialog-section { margin: 0 0 14px; }
#${DIALOG_ID} .tui-dialog-section:last-child { margin-bottom: 0; }
#${DIALOG_ID} .tui-dialog-section-title {
  margin-bottom: 8px;
  color: var(--color-text-secondary, currentColor);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: .02em;
  text-transform: uppercase;
}
#${DIALOG_ID} .tui-dialog-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
#${DIALOG_ID} .tui-dialog-card {
  min-width: 0;
  padding: 9px 10px;
  background: var(--tui-surface-2);
  border: 1px solid var(--color-border, var(--border-color, rgba(127, 127, 127, .16)));
  border-radius: 8px;
}
#${DIALOG_ID} .tui-dialog-card-label {
  color: var(--tui-text-dim);
  font-size: 10px;
}
#${DIALOG_ID} .tui-dialog-card-value {
  margin-top: 2px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
#${DIALOG_ID} .tui-dialog-card-note {
  margin-top: 2px;
  color: var(--tui-text-dim);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${DIALOG_ID} .tui-dialog-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  border-bottom: 1px solid var(--color-border, var(--border-color, rgba(127, 127, 127, .12)));
}
#${DIALOG_ID} .tui-dialog-row:last-child { border-bottom: 0; }
#${DIALOG_ID} .tui-dialog-row-label { color: var(--color-text-secondary, currentColor); }
#${DIALOG_ID} .tui-dialog-row-value {
  font-variant-numeric: tabular-nums;
  font-weight: 550;
  text-align: right;
}
#${DIALOG_ID} .tui-dialog-context {
  padding: 10px;
  background: var(--tui-surface-2);
  border-radius: 8px;
}
#${DIALOG_ID} .tui-dialog-context-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
#${DIALOG_ID} .tui-dialog-context-value { font-variant-numeric: tabular-nums; font-weight: 600; }
#${DIALOG_ID} .tui-dialog-context-bar {
  height: 6px;
  margin-top: 8px;
  overflow: hidden;
  background: var(--tui-surface-3);
  border-radius: 999px;
}
#${DIALOG_ID} .tui-dialog-context-fill {
  width: 0;
  height: 100%;
  background: var(--color-accent, var(--color-primary, #6ea8fe));
  border-radius: inherit;
  transition: width .16s ease;
}
#${DIALOG_ID} .tui-dialog-list {
  overflow: hidden;
  border: 1px solid var(--color-border, var(--border-color, rgba(127, 127, 127, .16)));
  border-radius: 8px;
}
#${DIALOG_ID} .tui-dialog-list-item {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--color-border, var(--border-color, rgba(127, 127, 127, .12)));
}
#${DIALOG_ID} .tui-dialog-list-item:last-child { border-bottom: 0; }
#${DIALOG_ID} .tui-dialog-list-item-current { background: var(--tui-surface-2); }
#${DIALOG_ID} .tui-dialog-list-index {
  color: var(--tui-text-dim);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
}
#${DIALOG_ID} .tui-dialog-list-main { min-width: 0; }
#${DIALOG_ID} .tui-dialog-list-title { font-weight: 550; }
#${DIALOG_ID} .tui-dialog-list-note {
  margin-top: 1px;
  color: var(--tui-text-dim);
  font-size: 10px;
}
#${DIALOG_ID} .tui-dialog-list-total { font-variant-numeric: tabular-nums; font-weight: 550; text-align: right; }
#${DIALOG_ID} .tui-dialog-muted {
  color: var(--tui-text-dim);
  font-size: 11px;
}
#${DIALOG_ID} .tui-dialog-notice {
  margin: 0 0 12px;
  padding: 8px 10px;
  color: var(--color-text-secondary, currentColor);
  background: var(--tui-surface-2);
  border-radius: 8px;
  font-size: 11px;
}
@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID}, #${DIALOG_ID} * { transition: none; }
}
`;
    document.head.appendChild(style);
  }

  function makeMetric(label, className) {
    const span = document.createElement("span");
    span.className = "tui-native-metric " + className;
    const labelNode = document.createElement("span");
    labelNode.className = "tui-native-label";
    labelNode.textContent = label;
    const valueNode = document.createElement("span");
    valueNode.className = "tui-native-value";
    valueNode.textContent = "--";
    span.append(labelNode, valueNode);
    return { span, labelNode, valueNode };
  }

  function buildRoot() {
    const root = document.createElement("span");
    root.id = ROOT_ID;
    root.setAttribute("role", "button");
    root.setAttribute("tabindex", "0");
    root.setAttribute("aria-haspopup", "dialog");
    root.setAttribute("aria-controls", DIALOG_ID);
    root.setAttribute("aria-expanded", "false");
    root.setAttribute("aria-live", "off");

    const primary = document.createElement("span");
    primary.className = "tui-native-primary";
    const session = makeMetric("会话", "tui-native-session");
    const turn = makeMetric("当前提问", "tui-native-turn");
    const requests = makeMetric("请求", "tui-native-requests");
    primary.append(session.span, turn.span, requests.span);

    const secondary = document.createElement("span");
    secondary.className = "tui-native-secondary";
    // 第二行：速度 · 命中率 · 命中 · 输出。
    // 「缓存未命中」已按要求从紧凑条移除（详情弹层「当前提问统计」仍保留该格）。
    const tps = makeMetric("速度", "tui-native-tps");
    const hitRate = makeMetric("命中率", "tui-native-hitrate");
    const cached = makeMetric("命中", "tui-native-cached");
    const output = makeMetric("输出", "tui-native-output");
    secondary.append(tps.span, hitRate.span, cached.span, output.span);

    root.append(primary, secondary);
    root.__tuiMetrics = { session, turn, requests, tps, hitRate, cached, output };

    // 悬浮冻结（方案甲）：指针停留期间不改写任何显示；移出后立即补一次渲染，避免留下旧值。
    root.addEventListener("pointerenter", () => { state.hoverFrozen = true; });
    root.addEventListener("pointerleave", () => { state.hoverFrozen = false; render(); });
    root.addEventListener("click", (event) => {
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      openDetails();
    });
    return root;
  }

  function dialogSection(title, content) {
    const section = textNode("section", "tui-dialog-section");
    section.append(textNode("div", "tui-dialog-section-title", title), content);
    return section;
  }

  function dialogCard(label, value, note) {
    const card = textNode("div", "tui-dialog-card");
    card.append(textNode("div", "tui-dialog-card-label", label));
    // value 既可以是字符串，也可以已是 DOM 节点（例如可点击展开的「输入/缓存命中」单元格）。
    // 只对节点走 append 分支，其它情况保持原有行为不变。
    if (value && value.nodeType === 1) {
      const holder = textNode("div", "tui-dialog-card-value");
      holder.append(value);
      card.append(holder);
    } else {
      card.append(textNode("div", "tui-dialog-card-value", value));
    }
    if (note) card.append(textNode("div", "tui-dialog-card-note", note));
    return card;
  }

  function dialogGrid(items) {
    const grid = textNode("div", "tui-dialog-grid");
    for (const item of items) grid.append(dialogCard(item[0], item[1], item[2]));
    return grid;
  }

  // ---------------------------------------------------------------------------
  // 详情框：骨架构建 + 增量更新
  //
  // 背景：原实现每次数据变化都对详情框主体做 replaceChildren 全量重建
  //（实测单次约 17ms，且会丢失滚动位置与「输入/缓存命中」的展开状态）。
  // 现在改为：
  //   1. 骨架（六个分区）只在打开详情框、或从「无数据」恢复时构建一次；
  //   2. 数据变化走增量更新：固定区直接改文本（不重建节点）；
  //   3. 列表区按「结构指纹」判断（条数、首尾序号、截断标志、总数），
  //      只有结构真正变化才重建列表；
  //   4. 结构未变时只更新最后一行（会话进行中通常只有最后一行在变化）。
  // 参考 web.dev《Avoid large, complex layouts and layout thrashing》：
  // 避免无谓的强制同步布局 —— 增量路径不重新定位（尺寸未变）。
  // ---------------------------------------------------------------------------

  function setCellText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  // 「输入/缓存命中」单元格：默认缩写（xxk/xxk），单击展开为完整数字，再次单击切回。
  // 展开状态存放在详情框级对象（pairState）里，因此不会因更新/重建而丢失。
  function makePairCell(pairState, key, inputValue, cachedValue) {
    const node = textNode("span", "tui-dialog-pair");
    node.style.cursor = "pointer";
    node.title = "单击查看完整数字";
    node.__tuiPairValue = { input: inputValue, cached: cachedValue };
    const render = () => {
      const value = node.__tuiPairValue;
      node.textContent = pairState[key]
        ? tokenText(value.input) + "/" + tokenText(value.cached)
        : fmtShort(value.input) + "/" + fmtShort(value.cached);
    };
    node.__tuiPairUpdate = (nextInput, nextCached) => {
      node.__tuiPairValue = { input: nextInput, cached: nextCached };
      render();
    };
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      pairState[key] = !pairState[key];
      render();
    });
    render();
    return node;
  }

  function updatePairCell(holder, inputValue, cachedValue) {
    const cell = holder && holder.firstChild;
    if (cell && cell.__tuiPairUpdate) cell.__tuiPairUpdate(inputValue, cachedValue);
  }

  // 用 items 填充已有的列表节点；返回行元素数组（供「只更新最后一行」复用）。
  function fillList(listNode, items, renderItem) {
    if (!items.length) {
      listNode.replaceChildren(textNode("div", "tui-dialog-muted", "暂无可展示的数据"));
      return [];
    }
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < items.length; index += 1) fragment.append(renderItem(items[index], index));
    listNode.replaceChildren(fragment);
    return [...listNode.children];
  }

  function requestNoteText(request) {
    return `${request.time || "时间未知"} · 输入 ${fmtShort(request.input)} · 命中 ${fmtShort(request.cached)} · 未命中 ${fmtShort(request.uncached)} · 输出 ${fmtShort(request.output)}`;
  }

  function buildRequestRow(request) {
    const row = textNode("div", "tui-dialog-list-item");
    const index = request.index || "--";
    const main = textNode("div", "tui-dialog-list-main");
    const note = textNode("div", "tui-dialog-list-note", requestNoteText(request));
    const total = textNode("div", "tui-dialog-list-total", fmtShort(request.total));
    main.append(textNode("div", "tui-dialog-list-title", `第 ${index} 次请求`), note);
    row.append(textNode("div", "tui-dialog-list-index", `#${index}`), main, total);
    row.__tuiFields = { note, total };
    return row;
  }

  function updateRequestRow(row, request) {
    if (!row || !row.__tuiFields) return;
    setCellText(row.__tuiFields.note, requestNoteText(request));
    setCellText(row.__tuiFields.total, fmtShort(request.total));
  }

  function turnNoteText(turn) {
    return `${turn.startLabel || "时间未知"} · ${fmtInt(turn.requests)} 次请求 · 输入 ${fmtShort(turn.input)} · 输出 ${fmtShort(turn.output)}`;
  }

  function buildTurnRow(turn, index, isCurrent) {
    const row = textNode("div", "tui-dialog-list-item" + (isCurrent ? " tui-dialog-list-item-current" : ""));
    const main = textNode("div", "tui-dialog-list-main");
    const note = textNode("div", "tui-dialog-list-note", turnNoteText(turn));
    const total = textNode("div", "tui-dialog-list-total", fmtShort(turn.total));
    const label = isCurrent ? `第 ${turn.index || index + 1} 轮 · 当前` : `第 ${turn.index || index + 1} 轮`;
    main.append(textNode("div", "tui-dialog-list-title", label), note);
    row.append(textNode("div", "tui-dialog-list-index", `T${turn.index || index + 1}`), main, total);
    row.__tuiFields = { note, total };
    return row;
  }

  function updateTurnRow(row, turn) {
    if (!row || !row.__tuiFields) return;
    setCellText(row.__tuiFields.note, turnNoteText(turn));
    setCellText(row.__tuiFields.total, fmtShort(turn.total));
  }

  // 列表区增量更新：指纹不变时只更新最后一行，指纹变化才重建列表。
  // 返回 true 表示发生了结构重建（调用方据此决定是否需要重新定位/恢复滚动）。
  function applyListUpdate(listState, options) {
    if (listState.fingerprint === options.fingerprint) {
      const lastIndex = options.items.length - 1;
      if (lastIndex >= 0 && options.updateRow) {
        options.updateRow(listState.rows[lastIndex], options.items[lastIndex], lastIndex);
      }
      return false;
    }
    // 重建会改变内容高度并重置滚动位置，这里先记录、后恢复。
    const body = listState.list.closest ? listState.list.closest(".tui-dialog-body") : null;
    const scrollTop = body ? body.scrollTop : 0;
    if (listState.notice && listState.notice.parentElement) listState.notice.remove();
    listState.notice = null;
    if (options.noticeText) {
      listState.notice = textNode("div", "tui-dialog-notice", options.noticeText);
      listState.section.insertBefore(listState.notice, listState.list);
    }
    listState.rows = fillList(listState.list, options.items, options.buildRow);
    listState.fingerprint = options.fingerprint;
    if (body && scrollTop > 0) body.scrollTop = scrollTop;
    return true;
  }

  // 构建详情框骨架（只在打开详情框或从「无数据」恢复时执行一次）。
  function buildDetailsParts(data) {
    const m = detailMetrics(data);
    const parts = { pairState: {}, sections: [] };

    // 会话累计
    const sessionGrid = dialogGrid([
      ["总量", tokenText(data.sessionTotal)],
      ["请求", fmtInt(data.requestCount)],
      ["输入/缓存命中", makePairCell(parts.pairState, "session", m.sessionInput, m.sessionCached)],
      ["平均速度", data.sessionTps == null ? "-- Tokens/s" : data.sessionTps.toFixed(1) + " Tokens/s"],
      ["缓存未命中", tokenText(m.sessionUncached)],
      ["输出", tokenText(data.sessionOutput)],
    ]);
    const sessionCells = [...sessionGrid.querySelectorAll(".tui-dialog-card-value")];
    parts.session = {
      total: sessionCells[0], requests: sessionCells[1], pair: sessionCells[2],
      tps: sessionCells[3], uncached: sessionCells[4], output: sessionCells[5],
    };
    parts.sections.push(dialogSection("会话累计", sessionGrid));

    // 当前提问统计
    const turnGrid = dialogGrid([
      ["总量", tokenText(m.turnTotal)],
      ["请求", fmtInt(m.currentRequestCount)],
      ["输入/缓存命中", makePairCell(parts.pairState, "turn", m.turnInput, m.turnCached)],
      ["本轮平均速度", data.turnTps == null ? "-- Tokens/s" : data.turnTps.toFixed(1) + " Tokens/s"],
      ["缓存未命中", tokenText(m.turnUncached)],
      ["输出", tokenText(m.turnOutput)],
    ]);
    const turnCells = [...turnGrid.querySelectorAll(".tui-dialog-card-value")];
    parts.turn = {
      total: turnCells[0], requests: turnCells[1], pair: turnCells[2],
      tps: turnCells[3], uncached: turnCells[4], output: turnCells[5],
    };
    parts.sections.push(dialogSection("当前提问统计", turnGrid));

    // 上下文使用
    const contextValue = textNode("span", "tui-dialog-context-value", tokenText(m.contextUsed));
    const contextLimit = textNode("span", "tui-dialog-muted", m.modelContextWindow == null ? "上下文上限未知" : `上限 ${tokenText(m.modelContextWindow)}`);
    const contextTop = textNode("div", "tui-dialog-context-top");
    contextTop.append(contextValue, contextLimit);
    const contextFill = textNode("div", "tui-dialog-context-fill");
    const contextPercent = percent(m.contextUsed, m.modelContextWindow);
    contextFill.style.width = contextPercent == null ? "0%" : `${contextPercent}%`;
    const contextBar = textNode("div", "tui-dialog-context-bar");
    contextBar.append(contextFill);
    const contextBox = textNode("div", "tui-dialog-context");
    contextBox.append(contextTop, contextBar);
    parts.context = { value: contextValue, limit: contextLimit, fill: contextFill };
    parts.sections.push(dialogSection("上下文使用", contextBox));

    // 运行状态
    const health = data.health || {};
    const healthGrid = dialogGrid([
      ["状态", healthLabel(health)],
      ["监控", health.monitorRunning === false ? "未运行" : "运行中"],
      ["页面连接", health.pageAttached ? "已连接" : "等待连接"],
      ["数据", health.dataFresh ? "最新" : "等待更新"],
      ["窗口选择", health.targetSelection === "required" ? "需要指定窗口" : (health.targetSelection || "自动")],
      ["模型切换", fmtInt(data.modelSwitchCount) + " 次"],
      ["累计重置", fmtInt(data.cumulativeResetCount) + " 次"],
      ["恢复", health.recoveryState === "recovered" ? "已恢复" : (health.recoveryState || "正常")],
    ]);
    const healthCells = [...healthGrid.querySelectorAll(".tui-dialog-card-value")];
    parts.health = {
      status: healthCells[0], monitor: healthCells[1], page: healthCells[2], data: healthCells[3],
      target: healthCells[4], modelSwitches: healthCells[5], resets: healthCells[6], recovery: healthCells[7],
    };
    parts.sections.push(dialogSection("运行状态", healthGrid));

    // 当前提问请求明细（列表内容由 applyListUpdate 填充）
    const requestSection = textNode("div", "tui-dialog-section");
    requestSection.append(textNode("div", "tui-dialog-section-title", "当前提问请求明细"));
    const requestList = textNode("div", "tui-dialog-list");
    const requestMore = dialogMoreButton("requests");
    requestSection.append(requestList, requestMore);
    parts.requestList = { section: requestSection, list: requestList, notice: null, rows: [], fingerprint: "", more: requestMore };
    parts.sections.push(requestSection);

    // 各轮摘要（标题与列表内容由 updateDetailsParts 填充）
    const turnSection = textNode("div", "tui-dialog-section");
    const turnTitle = textNode("div", "tui-dialog-section-title");
    const turnList = textNode("div", "tui-dialog-list");
    const turnMore = dialogMoreButton("turns");
    turnSection.append(turnTitle, turnList, turnMore);
    parts.turnList = { section: turnSection, title: turnTitle, list: turnList, notice: null, rows: [], fingerprint: "", more: turnMore };
    parts.sections.push(turnSection);

    return parts;
  }

  // 「加载更多」宽按钮：撑满列表宽度；点击后扩大推送窗口，由监控按需回推。
  function dialogMoreButton(kind) {
    const button = textNode("button", "tui-dialog-more", "加载更多");
    button.type = "button";
    button.hidden = true;
    button.style.cssText = "display:block;width:100%;margin-top:8px;padding:7px 10px;font:inherit;font-size:12px;text-align:center;cursor:pointer;color:inherit;background:var(--tui-surface-2,rgba(127,127,127,.10));border:1px solid var(--tui-border,rgba(127,127,127,.28));border-radius:8px;";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (kind === "turns") state.windowTurns = Math.min(state.windowTurns + TURN_WINDOW_STEP, state.turnsLimit);
      else state.windowRequests = Math.min(state.windowRequests + REQUEST_WINDOW_STEP, state.requestsLimit);
      button.textContent = "加载中…";
      button.disabled = true;
      publishWindow();
    });
    return button;
  }

  // 更新按钮文案与显隐：truncated=还有未推送的数据；loaded/total 用于「已加载 X / 共 Y」。
  function updateMoreButton(button, truncated, loaded, total, unit, limit) {
    if (!button) return;
    if (!truncated) {
      button.hidden = true;
      button.disabled = false;
      return;
    }
    const atLimit = Number.isFinite(limit) && loaded >= limit;
    button.disabled = atLimit;
    button.textContent = atLimit
      ? "已加载最新 " + fmtInt(loaded) + " " + unit + "（已达上限）"
      : "加载更多（已加载最新 " + fmtInt(loaded) + " / 共 " + fmtInt(total) + " " + unit + "）";
    button.hidden = false;
  }

  // 增量更新：只改文本/宽度，不重建节点。返回 true 表示列表发生了结构重建。
  function updateDetailsParts(parts, data) {
    const m = detailMetrics(data);

    setCellText(parts.session.total, tokenText(data.sessionTotal));
    setCellText(parts.session.requests, fmtInt(data.requestCount));
    updatePairCell(parts.session.pair, m.sessionInput, m.sessionCached);
    setCellText(parts.session.tps, data.sessionTps == null ? "-- Tokens/s" : data.sessionTps.toFixed(1) + " Tokens/s");
    setCellText(parts.session.uncached, tokenText(m.sessionUncached));
    setCellText(parts.session.output, tokenText(data.sessionOutput));

    setCellText(parts.turn.total, tokenText(m.turnTotal));
    setCellText(parts.turn.requests, fmtInt(m.currentRequestCount));
    updatePairCell(parts.turn.pair, m.turnInput, m.turnCached);
    setCellText(parts.turn.tps, data.turnTps == null ? "-- Tokens/s" : data.turnTps.toFixed(1) + " Tokens/s");
    setCellText(parts.turn.uncached, tokenText(m.turnUncached));
    setCellText(parts.turn.output, tokenText(m.turnOutput));

    setCellText(parts.context.value, tokenText(m.contextUsed));
    setCellText(parts.context.limit, m.modelContextWindow == null ? "上下文上限未知" : `上限 ${tokenText(m.modelContextWindow)}`);
    const contextPercent = percent(m.contextUsed, m.modelContextWindow);
    const contextWidth = contextPercent == null ? "0%" : `${contextPercent}%`;
    if (parts.context.fill.style.width !== contextWidth) parts.context.fill.style.width = contextWidth;

    const health = data.health || {};
    setCellText(parts.health.status, healthLabel(health));
    setCellText(parts.health.monitor, health.monitorRunning === false ? "未运行" : "运行中");
    setCellText(parts.health.page, health.pageAttached ? "已连接" : "等待连接");
    setCellText(parts.health.data, health.dataFresh ? "最新" : "等待更新");
    setCellText(parts.health.target, health.targetSelection === "required" ? "需要指定窗口" : (health.targetSelection || "自动"));
    setCellText(parts.health.modelSwitches, fmtInt(data.modelSwitchCount) + " 次");
    setCellText(parts.health.resets, fmtInt(data.cumulativeResetCount) + " 次");
    setCellText(parts.health.recovery, health.recoveryState === "recovered" ? "已恢复" : (health.recoveryState || "正常"));

    // 倒序展示：最新的请求在最上面（负载本身是升序，这里只反转展示顺序）。
    // 上限由监控下发；会话总量回退（通常=切换了会话/会话重置）时把翻页位置收回默认档，
    // 避免在别的会话里继续请求上一个会话翻到的大窗口。
    if (Number.isFinite(data.turnsLimit)) state.turnsLimit = data.turnsLimit;
    if (Number.isFinite(data.requestsLimit)) state.requestsLimit = data.requestsLimit;
    const requests = Array.isArray(data.requestDetails) ? data.requestDetails.slice().reverse() : [];
    const requestRebuilt = applyListUpdate(parts.requestList, {
      fingerprint: [
        requests.length,
        requests.length ? requests[0].index || 0 : 0,
        requests.length ? requests[requests.length - 1].index || 0 : 0,
        data.requestDetailsTruncated ? 1 : 0,
        data.requestDetailTotal == null ? "" : String(data.requestDetailTotal),
      ].join("|"),
      noticeText: "",
      items: requests,
      buildRow: (request) => buildRequestRow(request),
      updateRow: (row, request) => updateRequestRow(row, request),
    });

    // 倒序展示：最新的一轮在最上面，列表底部是更早的轮次（配合「加载更多」向下翻旧数据）。
    const turns = Array.isArray(data.turns) ? data.turns.slice().reverse() : [];
    const turnTotalCount = data.turnTotalCount != null ? data.turnTotalCount : turns.length;
    setCellText(parts.turnList.title, data.turnsTruncated
      ? "各轮摘要（" + fmtInt(turnTotalCount) + " 轮）"
      : `各轮摘要（${fmtInt(turns.length)} 轮）`);
    updateMoreButton(parts.requestList.more, !!data.requestDetailsTruncated, requests.length, data.requestDetailTotal == null ? requests.length : data.requestDetailTotal, "条", state.requestsLimit);
    updateMoreButton(parts.turnList.more, !!data.turnsTruncated, turns.length, turnTotalCount, "轮", state.turnsLimit);

    const turnRebuilt = applyListUpdate(parts.turnList, {
      fingerprint: [
        turns.length,
        turns.length ? turns[0].index || 0 : 0,
        turns.length ? turns[turns.length - 1].index || 0 : 0,
        data.turnsTruncated ? 1 : 0,
        String(turnTotalCount),
      ].join("|"),
      noticeText: "",
      items: turns,
      buildRow: (turn, index) => buildTurnRow(turn, index, index === 0),
      updateRow: (row, turn) => updateTurnRow(row, turn),
    });

    return requestRebuilt || turnRebuilt;
  }

  function formatUpdatedAt(value) {
    if (!value) return "等待监控数据";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "最近更新：--";
    return `更新于 ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  }

  function formatSubtitle(data) {
    if (!data) return state.protocolError ? "协议不匹配 · 请重新加载 Codex++ 用户脚本" : "等待监控数据";
    return `${healthLabel(data.health)} · ${formatUpdatedAt(data.updatedAt)}`;
  }

 function detailMetrics(data) {
   const turn = currentTurnOf(data);
    const sessionSplit = cacheSplit(data && data.sessionInput, data && data.sessionCached);
    const turnSplit = cacheSplit(
      data && data.turnInput != null ? data.turnInput : turn && turn.input,
      data && data.turnCached != null ? data.turnCached : turn && turn.cached,
    );
   return {
     turn,
      sessionInput: sessionSplit.input,
      sessionCached: sessionSplit.cached,
      sessionUncached: sessionSplit.uncached,
      turnInput: turnSplit.input,
      turnCached: turnSplit.cached,
      turnUncached: turnSplit.uncached,
      turnOutput: data && data.turnOutput != null ? data.turnOutput : turn && turn.output,
      turnTotal: data && data.turnTotal != null ? data.turnTotal : turn && turn.total,
      currentRequestCount: data && data.requestDetailTotal != null
        ? data.requestDetailTotal
        : turn && turn.requests != null
          ? turn.requests
          : 0,
      contextUsed: data && data.contextUsed != null ? data.contextUsed : 0,
      modelContextWindow: data && data.modelContextWindow != null ? data.modelContextWindow : null,
    };
  }

  // 详情框渲染入口：首次构建骨架，之后一律走增量更新。
  // 返回 true 表示发生了结构性重建（调用方据此决定是否需要重新定位）。
  function renderDetails() {
    if (!state.dialog || !state.dialog.__tuiBody) return false;
    const dialog = state.dialog;
    const body = dialog.__tuiBody;
    const data = state.data;
    if (dialog.__tuiSubtitle) setCellText(dialog.__tuiSubtitle, formatSubtitle(data));
    dialog.__tuiRenderedDataKey = dataKeyOf(data);

    if (!data) {
      // 无数据：丢弃骨架并显示提示；数据恢复后重建（此路径开销可忽略）。
      dialog.__tuiParts = null;
      body.replaceChildren(textNode("div", "tui-dialog-notice", state.protocolError
        ? "统计协议与监控程序不匹配，请重新加载 Codex++ 用户脚本和监控进程。"
        : "监控数据尚未到达。统计条会在监控进程连接后自动更新。"));
      return true;
    }

    let parts = dialog.__tuiParts;
    let rebuilt = false;
    if (!parts) {
      parts = dialog.__tuiParts = buildDetailsParts(data);
      body.replaceChildren(...parts.sections);
      rebuilt = true;
    }
    if (updateDetailsParts(parts, data)) rebuilt = true;
    return rebuilt;
  }

  function buildDialog() {
    const dialog = textNode("div", "tui-dialog");
    dialog.id = DIALOG_ID;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "false");
    dialog.setAttribute("aria-labelledby", `${DIALOG_ID}-title`);
    dialog.setAttribute("aria-describedby", `${DIALOG_ID}-subtitle`);
    const header = textNode("div", "tui-dialog-header");
    const heading = textNode("div");
    heading.append(
      textNode("div", "tui-dialog-title", "Token 用量详情"),
      textNode("div", "tui-dialog-subtitle", "原生统计条 · 仅展示本地脱敏统计"),
    );
    heading.firstChild.id = `${DIALOG_ID}-title`;
    heading.lastChild.id = `${DIALOG_ID}-subtitle`;
    const close = textNode("button", "tui-dialog-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭详情");
    close.addEventListener("click", () => closeDetails());
    header.append(heading, close);
    const body = textNode("div", "tui-dialog-body");
    dialog.append(header, body);
   dialog.__tuiBody = body;
   dialog.__tuiSubtitle = heading.lastChild;
    dialog.__tuiClose = close;
   return dialog;
  }

  function positionDialog() {
    if (!state.dialog || !state.root || state.dialog.getAttribute("data-open") !== "true") return;
    const anchor = state.root.getBoundingClientRect();
    const width = state.dialog.offsetWidth;
    const height = state.dialog.offsetHeight;
    const margin = 12;
    let left = anchor.right - width;
    let top = anchor.bottom + 8;
    if (top + height > window.innerHeight - margin) top = anchor.top - height - 8;
    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));
    top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin));
    state.dialog.style.left = `${Math.round(left)}px`;
    state.dialog.style.top = `${Math.round(top)}px`;
  }

  // 点击外部关闭：主要关闭方式之一（另有详情框右上角的关闭按钮）。
  function onDocumentPointerDown(event) {
    if (!state.dialog) return;
    const target = event.target;
    if (state.dialog.contains(target)) return;
    if (state.root && state.root.contains(target)) return;
    closeDetails();
  }

  function openDetails() {
    if (!document.body) return;
    if (state.dialog && state.dialog.getAttribute("data-open") === "true") return;
    // 打开即声明「展开窗口」；监控最多 1 秒后按新窗口回推，第一眼会先看到已缓存的精简数据。
    state.windowTurns = Math.max(state.windowTurns, TURN_WINDOW_OPEN);
    state.windowRequests = Math.max(state.windowRequests, REQUEST_WINDOW_OPEN);
    publishWindow();
    if (!state.dialog) {
      state.previousFocus = document.activeElement;
      state.dialog = buildDialog();
      document.body.appendChild(state.dialog);
    applyTheme();
    }
    state.dialog.setAttribute("data-open", "true");
    state.dialog.style.visibility = "hidden";
    state.root && state.root.setAttribute("aria-expanded", "true");
    renderDetails();
    positionDialog();
   state.dialog.style.visibility = "visible";
    if (state.dialog.__tuiClose && typeof state.dialog.__tuiClose.focus === "function") {
      try { state.dialog.__tuiClose.focus({ preventScroll: true }); } catch { state.dialog.__tuiClose.focus(); }
    }
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    // mousedown 兜底：个别环境不派发 PointerEvent 时仍能点击外部关闭。
    document.addEventListener("mousedown", onDocumentPointerDown, true);
    window.addEventListener("resize", positionDialog, { passive: true });
    window.addEventListener("scroll", positionDialog, { passive: true, capture: true });
    requestAnimationFrame(positionDialog);
  }

  function closeDetails({ restoreFocus = true } = {}) {
    if (!state.dialog) return;
    // 关闭后回到极简负载（5 轮 / 0 条明细），下一次「加载更多」的起点也重置。
    state.windowTurns = TURN_WINDOW_CLOSED;
    state.windowRequests = REQUEST_WINDOW_CLOSED;
    publishWindow();
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("mousedown", onDocumentPointerDown, true);
    window.removeEventListener("resize", positionDialog);
    window.removeEventListener("scroll", positionDialog, true);
   const dialog = state.dialog;
    const focusTarget = state.previousFocus && state.previousFocus.isConnected
      ? state.previousFocus
      : state.root;
   state.dialog = null;
    if (dialog.parentElement) dialog.remove();
    if (state.root) {
      state.root.setAttribute("aria-expanded", "false");
      if (restoreFocus && focusTarget && typeof focusTarget.focus === "function") {
        try { focusTarget.focus({ preventScroll: true }); } catch { focusTarget.focus(); }
      }
    }
    state.previousFocus = null;
  }

  // ---- 主题判定 ----
  // 首选 Codex 自己在 <html> 上打的 data-theme；其次 color-scheme、文字亮度、系统偏好。
  const THEME_ATTR = "data-tui-theme";
  function luminanceOf(colorText) {
    if (!colorText) return null;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colorText.trim());
    let r, g, b;
    if (hex) {
      let h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    } else {
      const rgb = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(colorText);
      if (!rgb) return null;
      r = Number(rgb[1]); g = Number(rgb[2]); b = Number(rgb[3]);
    }
    if (![r, g, b].every(Number.isFinite)) return null;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function detectTheme() {
    const root = document.documentElement;
    const explicit = String(root.getAttribute("data-theme") || "").toLowerCase();
    if (explicit === "dark" || explicit === "light") return explicit;
    const scheme = String(getComputedStyle(root).colorScheme || "").toLowerCase();
    if (scheme.includes("dark") && !scheme.includes("light")) return "dark";
    if (scheme.includes("light") && !scheme.includes("dark")) return "light";
    const lum = luminanceOf(getComputedStyle(root).getPropertyValue("--color-text"));
    if (lum != null) return lum > 0.5 ? "dark" : "light";
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch (e) { return "light"; }
  }

  function setThemeAttr(el, theme) {
    if (el && el.getAttribute(THEME_ATTR) !== theme) el.setAttribute(THEME_ATTR, theme);
  }

  // 注意：不能因为「本次主题与上次相同」就提前返回。
  // 弹层是懒创建的（用户首次点击才生成），晚于统计条出现；
  // 提前返回会导致它永远拿不到主题属性，回退到浅色 token（踩过一次）。
  function applyTheme() {
    const theme = detectTheme();
    state.theme = theme;
    setThemeAttr(state.root, theme);
    setThemeAttr(state.dialog, theme);
    return theme;
  }

  function findContextRing() {
    const candidates = [...document.querySelectorAll(
      '[aria-label*="上下文用量"], [aria-label*="上下文窗口"], [aria-label*="Context usage" i], [aria-label*="Context window" i]'
    )].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.querySelector("svg");
    });
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.width * ar.height - br.width * br.height;
    });
    return candidates[0] || null;
  }

  function findMountPoint(ring) {
    let host = ring.parentElement;
    for (let depth = 0; host && depth < 8; depth += 1, host = host.parentElement) {
      const style = getComputedStyle(host);
      if (style.display === "flex" && host.children.length >= 2) break;
    }
    if (!host) return null;

    return { container: host, before: ring.parentElement };
  }

  function setMetric(metric, value) {
    if (metric && metric.valueNode && metric.valueNode.textContent !== value) metric.valueNode.textContent = value;
  }

  function render() {
    if (!state.root) return;
    applyTheme();
    const metrics = state.root.__tuiMetrics;
    const d = state.data;
    const hasData = !!d;
    const legacyTurn = d && Array.isArray(d.turns) && d.turns.length ? d.turns[d.turns.length - 1] : null;
    const turnTotal = d && d.turnTotal != null ? d.turnTotal : legacyTurn && legacyTurn.total;
    const turnInputValue = d && d.turnInput != null ? d.turnInput : legacyTurn && legacyTurn.input;
    const turnCachedValue = d && d.turnCached != null ? d.turnCached : legacyTurn && legacyTurn.cached;
    const turnOutput = d && d.turnOutput != null ? d.turnOutput : legacyTurn && legacyTurn.output;
    const turnSplit = cacheSplit(turnInputValue, turnCachedValue);
    const turnCached = turnSplit.cached;
    const turnUncached = turnSplit.uncached;

    // 会话切换（监控下发的一次性信号）：把「记住的翻页位置」收回默认档。
    // 必须放在 render() 里而不是详情更新里 —— 用户通常是「关着弹层切会话」，
    // 那时 updateDetailsParts 根本不会执行（旧实现因此完全失效）。
    if (d && d.sessionChanged === true) {
      state.windowTurns = state.dialog ? TURN_WINDOW_OPEN : TURN_WINDOW_CLOSED;
      state.windowRequests = state.dialog ? REQUEST_WINDOW_OPEN : REQUEST_WINDOW_CLOSED;
      publishWindow();
    }

    // 速度格：整数 + T/s；无数据时为 --T/s。
    // 注：T1 实测已确认「生成过程中的实时估算」在当前 Codex 渲染方式下不可实现
    //（页面按节点替换而非字符追加，且工具块会折叠/展开），因此这里暂时显示官方口径：
    // 上一条已完成请求的速度（lastRequestTps）；待替代信号确定后再切实时值。
    const tpsText = hasData && Number.isFinite(d.lastRequestTps) ? Math.round(d.lastRequestTps) + "T/s" : "--T/s";

    // 悬浮冻结：以下所有写入在指针悬停时整体跳过（移出后由 pointerleave 补渲染）。
    if (!state.hoverFrozen) {
    setMetric(metrics.session, hasData ? fmtShort(d.sessionTotal) : "--");
    setMetric(metrics.turn, hasData ? fmtShort(turnTotal) : "--");
    setMetric(metrics.requests, hasData ? fmtInt(d.requestCount) : "--");
    setMetric(metrics.tps, tpsText);
    setMetric(metrics.cached, hasData ? fmtShort(turnCached) : "--");
    setMetric(
      metrics.hitRate,
      hasData && d.turnCacheHitRate != null ? (d.turnCacheHitRate * 100).toFixed(1) + "%" : "--",
    );
    setMetric(metrics.output, hasData ? fmtShort(turnOutput) : "--");

    const sessionSplit = cacheSplit(d && d.sessionInput, d && d.sessionCached);
    const sessionInput = sessionSplit.input;
    const sessionCached = sessionSplit.cached;
    const sessionUncached = sessionSplit.uncached;
    const label = hasData
      ? `速度 ${tpsText}，会话 ${fmtInt(d.sessionTotal)}，当前提问 ${fmtInt(turnTotal)}，请求 ${fmtInt(d.requestCount)}；当前提问命中 ${fmtInt(turnCached)}，未命中 ${fmtInt(turnUncached)}，输出 ${fmtInt(turnOutput)}；会话输入 ${fmtInt(sessionInput)}，命中 ${fmtInt(sessionCached)}，未命中 ${fmtInt(sessionUncached)}，输出 ${fmtInt(d.sessionOutput)}`
      : state.protocolError ? "Token 统计协议不匹配" : "Token 统计等待监控数据";
    const accessibleLabel = `${label}；左键查看详细统计`;
    if (state.root.getAttribute("aria-label") !== accessibleLabel) state.root.setAttribute("aria-label", accessibleLabel);
    state.root.title = accessibleLabel;
    state.root.classList.toggle("tui-native-stale", !hasData || !!(d && d.health && d.health.status !== "healthy"));
    state.root.classList.toggle("tui-native-error", !!state.protocolError || !!(d && d.health && ["failed", "protocol-mismatch", "target-selection-required"].includes(d.health.status)));
    }
    if (state.dialog) {
      // 每次都走增量更新（不再用 __tuiRenderedDataKey 门控，原因见 DATA_EVENT 处注释）。
      // 只有发生结构性重建（骨架/列表）时详情框尺寸才可能变化，才需要重新定位；
      // 增量更新不改尺寸，原地重新定位会白白触发一次强制同步布局。
      if (renderDetails()) positionDialog();
    }
  }

  function updateDensity() {
    if (!state.root || !state.container) return;
    const width = state.container.getBoundingClientRect().width;
    state.root.classList.toggle("tui-native-compact", width < 420 || window.innerWidth < 900);
  }

  function observeContainer(container) {
    if (state.container === container && state.resizeObserver) return;
    if (state.resizeObserver) state.resizeObserver.disconnect();
    state.container = container;
    if (typeof ResizeObserver === "function") {
      state.resizeObserver = new ResizeObserver(updateDensity);
      state.resizeObserver.observe(container);
    }
    updateDensity();
  }

  function mount() {
    state.mountQueued = false;
    installStyle();

    const ring = findContextRing();
    const point = ring ? findMountPoint(ring) : null;
    if (!point) {
      // 诊断线索：Codex 大更新可能改掉锚点的 aria-label 或挂载容器结构，
      // 导致统计条挂载不上。这里把原因明确写进页面，用来区分
      // 「Codex 页面结构变化」与「插件没装好 / 监控没运行」这两类完全不同的故障。
      const reason = ring ? "mount-point-missing" : "anchor-missing";
      if (window.__tuiForCodexStatus !== reason) {
        window.__tuiForCodexStatus = reason;
        window.__tuiForCodexStatusAt = new Date().toISOString();
        console.warn(
          "[Tokens UI For Codex] 统计条未挂载: " + reason +
            " —— 多为 Codex 页面结构调整所致（例如上下文圆圈的 aria-label 或输入区容器变了）。" +
            "Codex 本体不受影响；可在 Codex 中让 Agent 读取本状态并更新选择器。",
        );
      }
      if (state.dialog) closeDetails({ restoreFocus: false });
      if (state.root) state.root.remove();
      state.root = null;
      state.container = null;
      if (state.resizeObserver) state.resizeObserver.disconnect();
      return;
    }

    // 挂载成功：清除上一次的诊断状态
    if (window.__tuiForCodexStatus) {
      window.__tuiForCodexStatus = "";
      window.__tuiForCodexStatusAt = "";
    }

    if (!state.root) state.root = buildRoot();
    // insertBefore 的参考节点必须是容器的「直接子节点」，否则抛 NotFoundError
    // （浏览器原文：The node before which the new node is to be inserted is not a child of this node）。
    // 两种会踩中的真实场景：
    //   1) 上下文圆圈的父亲恰好就是容器 —— 此时 ref === container，等于「插到自己前面」；
    //   2) buildRoot() 期间 React 重渲染把 ref 移出 DOM，此时 ref.parentElement === null。
    // 处置：参考节点无效就改传 null —— MDN 明确「null 时元素仍会被追加到父节点末尾」，
    // 即统计条仍会显示，只是位置从「圆圈左侧」退化为「行末」，属于可接受的优雅降级。
    //
    // 注意：判断与插入必须使用同一个 before。若判断用原始 point.before、插入用降级后的
    // null，会在降级场景下永远判定「位置不对」→ 每次 mount 都重插一次 →
    // appendChild 对已存在的节点是「移动」（MDN），会产生 childList 变更 →
    // 触发重挂载 → 每帧循环（P3）。
    const before = point.before && point.before.parentElement === point.container ? point.before : null;
    const alreadyPlaced = state.root.parentElement === point.container &&
      (before ? state.root.nextSibling === before : state.root === point.container.lastElementChild);
    if (!alreadyPlaced) {
      try {
        point.container.insertBefore(state.root, before);
      } catch (error) {
        window.__tuiForCodexStatus = "insert-failed";
        window.__tuiForCodexStatusAt = new Date().toISOString();
        console.warn(
          "[Tokens UI For Codex] 统计条插入失败，已降级为追加到容器末尾: " +
            (error && error.message ? error.message : error),
        );
        try { point.container.appendChild(state.root); } catch {}
      }
    }
    observeContainer(point.container);
    render();
  }

  function queueMount() {
    if (state.mountQueued) return;
    state.mountQueued = true;
    // 兜底保护：mount() 内部（installStyle / findMountPoint / buildRoot /
    // observeContainer / render 等）任何一处抛异常，都由插件自己接住 ——
    // 写诊断状态 + 带指引的日志，而不是把异常穿透到 rAF 调度层成为裸的未捕获错误。
    // 这里显式复位 mountQueued 属于纵深防御：mount() 第一行虽然也会复位，
    // 但那是隐式依赖；一旦将来有人重排首行，队列就会永久卡死。
    requestAnimationFrame(() => {
      try {
        mount();
      } catch (error) {
        state.mountQueued = false;
        window.__tuiForCodexStatus = "mount-crashed";
        window.__tuiForCodexStatusAt = new Date().toISOString();
        console.error(
          "[Tokens UI For Codex] 挂载过程异常（已记录，将在下次页面变化时自动重试）: " +
            (error && error.message ? error.message : error),
        );
      }
    });
  }

  function installObservers() {
    if (state.mutationObserver || !document.documentElement) return;
    state.mutationObserver = new MutationObserver((records) => {
      const needsMount = records.some((record) => {
        if (!state.root || !state.root.isConnected) return true;
        if (state.root && (record.target === state.root || state.root.contains(record.target))) return false;
        // 面板自身被移动时会产生「removedNodes 与 addedNodes 都只有 state.root」的记录。
        // 那不表示面板被外部移除（那种情况由上面的 isConnected 检查兜底），不应触发重挂载——
        // 否则一旦位置判据出问题，就会形成「移动 → 重挂载 → 再移动」的自激循环（P3 加固）。
        if (record.type === "childList") {
          const touched = [...record.addedNodes, ...record.removedNodes];
          if (touched.length > 0 && touched.every((node) => node === state.root)) return false;
        }
        if (state.dialog && (record.target === state.dialog || state.dialog.contains(record.target))) return false;
        if (state.container && (record.target === state.container || state.container.contains(record.target))) return true;
        if (record.type === "attributes" && record.attributeName === "aria-label") {
          const label = record.target && record.target.getAttribute ? record.target.getAttribute("aria-label") : "";
          return typeof label === "string" && /上下文用量|上下文窗口|context usage|context window/i.test(label);
        }
        if (record.type === "childList") {
          return [...record.addedNodes, ...record.removedNodes].some((node) => {
            if (!node || node.nodeType !== 1) return false;
            const label = node.getAttribute && node.getAttribute("aria-label");
            // 廉价判断优先（性能优化 1）：先只读节点自身的 aria-label（廉价），
            // 仅当自身未命中、且节点确实存在元素子节点时，才做子树查询 ——
            // querySelector() 是深度优先遍历整个子树，成本随子树规模增长。
            // 语义等价：没有元素子节点的节点不可能存在后代元素，跳过子树查询是安全的。
            return (
              (typeof label === "string" && /上下文用量|上下文窗口|context usage|context window/i.test(label)) ||
              (node.childElementCount > 0 &&
                !!(node.querySelector && node.querySelector('[aria-label*="上下文用量"], [aria-label*="上下文窗口"], [aria-label*="Context usage" i], [aria-label*="Context window" i]')))
            );
          });
        }
        return false;
      });
      if (needsMount) queueMount();
    });
    state.mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-state", "data-testid"],
    });
    window.addEventListener("resize", updateDensity, { passive: true });
  }

  // 数据事件：监控进程写入 window.__tuiForCodex 后派发 tokens-ui-for-codex。
  const handleDataEvent = () => {
    const nextData = window.__tuiForCodex || null;
    adoptData(nextData);
    // 每次数据事件都渲染：内部全部是增量更新（实测 <1ms，最低成本已做 !== 检查）。
    // 不再用 dataKey 门控 —— 它曾漏掉 sessionTps / lastRequestTps / health 等字段，
    // 导致「速度或健康状态变化但界面不刷新」（P4）；去掉字段清单依赖后，
    // 未来新增字段也不会再漏，代价只是空闲时每 5 秒一次的空跑。
    render();
    if (!state.root || !state.root.isConnected) queueMount();
  };
  window.addEventListener(DATA_EVENT, handleDataEvent);

  const bootPayload = window.__tuiForCodex || null;
  if (bootPayload) {
    adoptData(bootPayload);
  }

  const start = () => {
    installObservers();
    // 初始挂载统一走 queueMount：与后续重挂载共用同一层异常保护与诊断状态。
    // 直接调用 mount() 时，初始异常只是一条裸的未捕获错误、且不写诊断状态，
    // 排障时无法区分「锚点缺失（Codex 改版）」与「插件自身抛错」。
    queueMount();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();

// Tokens UI For Codex —— Codex++ 用户脚本（统计条 + 详情弹层）
// 作者：Littps · 许可：MIT · 协议：tokens-ui-for-codex（签名 schema v3）
//
// 作用：把紧凑的 Token 统计条挂到输入区右下的「上下文用量圆圈」左侧，并提供左键单击打开的详情弹层。
// 依赖：本地监控进程 `node token-stats.mjs --watch --cdp`（经本地 CDP 推送签名 schema v3 负载）。
// 边界：不修改 Codex 的 React bundle、不注册任何键盘监听、不读取或展示用户消息正文。
// 安装：把本文件放入 %APPDATA%\Codex++\user_scripts\ ，并在 Codex++ 中启用用户脚本。
(() => {
  "use strict";

  // The widget is inserted beside Codex's native context ring. It deliberately
  // avoids patching React internals or showing a floating panel.
  const PROTOCOL_NAME = "tokens-ui-for-codex";
  const PROTOCOL_SCHEMA_VERSION = 3;
  const PROTOCOL_CAPABILITIES = [
    "session-total",
    "current-prompt-total",
    "request-count",
    "cache-split",
    "context-usage",
    "speed-estimate",
    "effective-speed",
    "turn-summaries",
    "request-details",
    "health-snapshot",
    "current-turn-request-count",
    "signed-payload",
    "robust-speed",
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
  // 弹层关闭时只要最近 5 轮（极简负载），打开时 10 轮 + 10 条请求明细；「加载更多」每次 +50 / +20。
  const TURN_WINDOW_CLOSED = 5;
  const TURN_WINDOW_OPEN = 10;
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
    themeObserver: null,
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
    // 折叠态陈旧检测：最近一次收到推送的时间（空闲心跳 5s / 运行中 1s；展开态不心跳）
    lastPayloadAt: 0,
    monitorStale: false,
    themeTimer: 0,
    // 上一份负载的会话总量，用于识别「切换了会话」（总量回退）
    lastSessionTotal: null,
    lastRenderSignature: "",
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
    if (data.authRequired !== true) return { ok: false, error: "统计协议要求签名负载" };
    if (!Array.isArray(data.capabilities) || !data.capabilities.includes("health-snapshot"))
      return { ok: false, error: "统计协议能力不匹配" };
    for (const key of [
      "requestCount",
      "currentTurnRequestCount",
      "turnTotal",
      "turnInput",
      "turnOutput",
      "currentTurnIndex",
      "turnTotalCount",
      "requestDetailTotal",
      "modelSwitchCount",
      "cumulativeResetCount",
    ]) {
      if (!isNonNegativeNumber(data[key])) return { ok: false, error: `${key} 字段无效` };
    }
    for (const key of ["compactSpeedSampleCount", "compactSpeedWindow"]) {
      if (data[key] != null && !isNonNegativeNumber(data[key])) return { ok: false, error: `${key} 字段无效` };
    }
    for (const key of [
      "sessionTotal",
      "contextUsed",
      "modelContextWindow",
      "sessionInput",
      "sessionCached",
      "sessionOutput",
      "turnCached",
      "turnTps",
      "turnWallTps",
      "sessionTps",
      "lastRequestTps",
      "genEstimateTps",
      "compactTps",
      "effectiveTps",
      "turnEffectiveTps",
    ]) {
      if (!isNullableNonNegativeNumber(data[key])) return { ok: false, error: `${key} 字段无效` };
    }
    for (const key of ["effectiveSampleCount", "effectiveWindow"]) {
      if (data[key] != null && !isNonNegativeNumber(data[key])) return { ok: false, error: `${key} 字段无效` };
    }
    if (data.speedTimingConfidence != null && !["high", "medium", "low"].includes(data.speedTimingConfidence)) {
      return { ok: false, error: "speedTimingConfidence 字段无效" };
    }
    if (data.compactSpeedConfidence != null && !["high", "medium", "low"].includes(data.compactSpeedConfidence)) {
      return { ok: false, error: "compactSpeedConfidence 字段无效" };
    }
    if (data.snapshot != null && typeof data.snapshot !== "boolean") return { ok: false, error: "snapshot 字段无效" };
    // 这两个上限原本写成「等于监控侧上限」，形成隐藏耦合：
    // 一旦监控侧放宽上限而面板未同步，面板会拒收整个负载 → 统计条什么数字都不显示，极难排查。
    // 因此这里只拦「荒谬值」（防御异常/恶意负载），正常超限由监控侧负责截断。
    // 监控侧对应常量：MAX_TURN_SUMMARIES / MAX_REQUEST_DETAILS（改动时无需同步本行）。
    if (!Array.isArray(data.turns) || data.turns.length > 500) return { ok: false, error: "轮次摘要超出限制" };
    if (!Array.isArray(data.requestDetails) || data.requestDetails.length > 500)
      return { ok: false, error: "请求明细超出限制" };
    for (const turn of data.turns) {
      if (
        !turn ||
        !Number.isInteger(turn.index) ||
        turn.index < 1 ||
        typeof turn.startLabel !== "string" ||
        !isNonNegativeNumber(turn.requests)
      ) {
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
      data.turnCacheHitRate,
      data.genEstimateTps,
      data.compactTps,
      data.compactSpeedSampleCount,
      data.compactSpeedConfidence,
      data.compactSpeedWindow,
      data.turnWallTps,
      data.sessionTps,
      data.lastRequestTps,
      data.turnTps,
      data.effectiveTps,
      data.turnEffectiveTps,
      data.effectiveSampleCount,
      data.speedTimingConfidence,
      data.snapshot ? "snapshot" : "",
      data.turnTotalCount,
      data.turnsTruncated,
      data.requestDetailTotal,
      data.modelSwitchCount,
      data.cumulativeResetCount,
      data.updatedAt,
      data.health && data.health.status,
      data.health && data.health.recoveryState,
      data.health && data.health.pageAttached,
      data.health && data.health.dataFresh,
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
  /* 磨砂玻璃（Medium）：14px 模糊 + 72% 底色 */
  --tui-glass-bg: rgba(255, 255, 255, .72);
  --tui-glass-border: rgba(255, 255, 255, .55);
  --tui-glass-highlight: rgba(255, 255, 255, .65);
  --tui-glass-blur: 14px;
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
  --tui-glass-bg: rgba(30, 30, 32, .62);
  --tui-glass-border: rgba(255, 255, 255, .14);
  --tui-glass-highlight: rgba(255, 255, 255, .10);
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
      /* Codex++ 的服务模式提示会占用输入框 footer 的横向空间；本插件的状态已
         移入详情标题，保留原生权限按钮不动。 */
      .codex-service-tier-badge { display: none !important; }
#${DIALOG_ID} {
  position: fixed;
  z-index: 2147483000;
  display: none;
  width: min(440px, calc(100vw - 24px));
  max-height: min(560px, calc(100vh - 24px));
  flex-direction: column;
  overflow: hidden;
  color: var(--tui-text);
  background: var(--tui-glass-bg);
  border: 1px solid var(--tui-glass-border);
  border-radius: 12px;
  box-shadow: var(--tui-shadow), inset 0 1px 0 var(--tui-glass-highlight);
  backdrop-filter: blur(var(--tui-glass-blur)) saturate(130%);
  -webkit-backdrop-filter: blur(var(--tui-glass-blur)) saturate(130%);
  contain: paint;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.4;
}
#${DIALOG_ID}[data-open="true"] { display: flex; animation: tui-dialog-in 140ms ease-out; }
/* 细噪点：静态 SVG（feTurbulence），只做一次合成，不参与模糊计算 */
#${DIALOG_ID}::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  border-radius: inherit;
  opacity: .035;
  background-image: url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iMTIwIj48ZmlsdGVyIGlkPSJuIj48ZmVUdXJidWxlbmNlIHR5cGU9ImZyYWN0YWxOb2lzZSIgYmFzZUZyZXF1ZW5jeT0iMC45IiBudW1PY3RhdmVzPSIyIiBzdGl0Y2hUaWxlcz0ic3RpdGNoIi8+PC9maWx0ZXI+PHJlY3Qgd2lkdGg9IjEyMCIgaGVpZ2h0PSIxMjAiIGZpbHRlcj0idXJsKCNuKSIvPjwvc3ZnPg==");
  background-size: 120px 120px;
}
#${DIALOG_ID} .tui-dialog-header,
#${DIALOG_ID} .tui-dialog-body { position: relative; z-index: 1; }
/* 自适应降级：帧时间过长时由脚本加上此类，退回实色，保证流畅 */
#${DIALOG_ID}.tui-glass-lite {
  background: var(--tui-surface);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
@keyframes tui-dialog-in {
  from { opacity: 0; transform: scale(.98); }
  to { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  #${DIALOG_ID}[data-open="true"] { animation: none; }
}
@media (prefers-reduced-transparency: reduce) {
  #${DIALOG_ID} { background: var(--tui-surface); backdrop-filter: none; -webkit-backdrop-filter: none; }
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  #${DIALOG_ID} { background: var(--tui-surface); }
}
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
      #${DIALOG_ID} .tui-dialog-title-row { display: flex; align-items: center; gap: 8px; }
      #${DIALOG_ID} .tui-dialog-health-dot {
        width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto;
        background: var(--color-warning, #d39e00);
        box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 18%, transparent);
      }
      #${DIALOG_ID} .tui-dialog-health-dot--green { background: #2fb344; }
      #${DIALOG_ID} .tui-dialog-health-dot--yellow { background: #d39e00; }
      #${DIALOG_ID} .tui-dialog-health-dot--red { background: var(--color-danger, #c0392b); }
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
#${DIALOG_ID} .tui-dialog-security {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 170, 0, .45);
  background: rgba(255, 170, 0, .08);
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.5;
}
#${DIALOG_ID} .tui-dialog-security-more {
  margin-top: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--tui-text-dim);
  font: inherit;
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
}
#${DIALOG_ID} .tui-dialog-security-list {
  margin-top: 6px;
  max-height: 90px;
  overflow: auto;
  color: var(--tui-text-dim);
  font-variant-numeric: tabular-nums;
}
#${DIALOG_ID} .tui-dialog-security-row { padding: 2px 0; }
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
    root.addEventListener("pointerenter", () => {
      state.hoverFrozen = true;
    });
    root.addEventListener("pointerleave", () => {
      state.hoverFrozen = false;
      render(true);
    });
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
    row.__tuiKey = String(request.index);
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
    row.__tuiKey = String(turn.index || index + 1);
    return row;
  }

  function updateTurnRow(row, turn) {
    if (!row || !row.__tuiFields) return;
    setCellText(row.__tuiFields.note, turnNoteText(turn));
    setCellText(row.__tuiFields.total, fmtShort(turn.total));
  }

  // 列表区增量更新：指纹不变时按稳定 key 更新所有行，指纹变化才重建列表。
  // 列表是倒序的，当前轮/最新请求在最上面；旧实现固定更新 lastIndex，
  // 实际改的是最老一行，导致当前轮摘要停在旧值。
  // 返回 true 表示发生了结构重建（调用方据此决定是否需要重新定位/恢复滚动）。
  function applyListUpdate(listState, options) {
    if (listState.fingerprint === options.fingerprint) {
      const rowsByKey = new Map();
      for (const row of listState.rows) {
        if (row && row.__tuiKey != null) rowsByKey.set(row.__tuiKey, row);
      }
      let updated = true;
      for (let index = 0; index < options.items.length; index += 1) {
        const item = options.items[index];
        const key = String(options.keyOf(item, index));
        const row = rowsByKey.get(key);
        if (!row) {
          updated = false;
          break;
        }
        if (options.updateRow) options.updateRow(row, item, index);
      }
      if (updated) return false;
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
      ["有效速度", data.effectiveTps == null ? "-- Tokens/s" : data.effectiveTps.toFixed(1) + " Tokens/s"],
      ["缓存未命中", tokenText(m.sessionUncached)],
      ["输出", tokenText(data.sessionOutput)],
    ]);
    const sessionCells = [...sessionGrid.querySelectorAll(".tui-dialog-card-value")];
    parts.session = {
      total: sessionCells[0],
      requests: sessionCells[1],
      pair: sessionCells[2],
      tps: sessionCells[3],
      uncached: sessionCells[4],
      output: sessionCells[5],
    };
    parts.session.tps.title = speedSampleTitle(data);
    parts.sections.push(dialogSection("会话累计", sessionGrid));

    // 当前提问统计
    const turnGrid = dialogGrid([
      ["总量", tokenText(m.turnTotal)],
      ["请求", fmtInt(m.currentRequestCount)],
      ["输入/缓存命中", makePairCell(parts.pairState, "turn", m.turnInput, m.turnCached)],
      ["本轮有效速度", data.turnEffectiveTps == null ? "-- Tokens/s" : data.turnEffectiveTps.toFixed(1) + " Tokens/s"],
      ["缓存未命中", tokenText(m.turnUncached)],
      ["输出", tokenText(m.turnOutput)],
    ]);
    const turnCells = [...turnGrid.querySelectorAll(".tui-dialog-card-value")];
    parts.turn = {
      total: turnCells[0],
      requests: turnCells[1],
      pair: turnCells[2],
      tps: turnCells[3],
      uncached: turnCells[4],
      output: turnCells[5],
    };
    parts.turn.tps.title = speedSampleTitle(data);
    parts.sections.push(dialogSection("当前提问统计", turnGrid));

    // 上下文使用
    const contextValue = textNode("span", "tui-dialog-context-value", tokenText(m.contextUsed));
    const contextLimit = textNode(
      "span",
      "tui-dialog-muted",
      m.modelContextWindow == null ? "上下文上限未知" : `上限 ${tokenText(m.modelContextWindow)}`,
    );
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

    // 运行状态（6 格；窗口选择/恢复已移除，多窗口与异常信息统一由「状态」格表达）
    const health = data.health || {};
    const healthGrid = dialogGrid([
      ["状态", healthLabel(health)],
      ["监控", health.monitorRunning === false ? "未运行" : "运行中"],
      ["页面连接", health.pageAttached ? "已连接" : "等待连接"],
      ["数据", health.dataFresh ? "最新" : "等待更新"],
      ["模型切换", fmtInt(data.modelSwitchCount) + " 次"],
      ["累计重置", fmtInt(data.cumulativeResetCount) + " 次"],
    ]);
    const healthCells = [...healthGrid.querySelectorAll(".tui-dialog-card-value")];
    parts.health = {
      status: healthCells[0],
      monitor: healthCells[1],
      page: healthCells[2],
      data: healthCells[3],
      modelSwitches: healthCells[4],
      resets: healthCells[5],
    };
    const healthBox = textNode("div", "tui-dialog-health");
    const securityBox = textNode("div", "tui-dialog-security");
    securityBox.hidden = true;
    const securityText = textNode("div", "tui-dialog-security-text", "");
    const securityMore = textNode("button", "tui-dialog-security-more", "详情");
    securityMore.type = "button";
    const securityList = textNode("div", "tui-dialog-security-list");
    securityList.hidden = true;
    securityMore.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      securityList.hidden = !securityList.hidden;
      securityMore.textContent = securityList.hidden ? "详情" : "收起";
    });
    securityBox.append(securityText, securityMore, securityList);
    healthBox.append(healthGrid, dialogStartButton(), securityBox);
    parts.security = { box: securityBox, text: securityText, list: securityList, more: securityMore, key: "" };
    parts.sections.push(dialogSection("运行状态", healthBox));

    // 当前提问请求明细（列表内容由 applyListUpdate 填充）
    const requestSection = textNode("div", "tui-dialog-section");
    requestSection.append(textNode("div", "tui-dialog-section-title", "当前提问请求明细"));
    const requestList = textNode("div", "tui-dialog-list");
    const requestMore = dialogMoreButton("requests");
    requestSection.append(requestList, requestMore);
    parts.requestList = {
      section: requestSection,
      list: requestList,
      notice: null,
      rows: [],
      fingerprint: "",
      more: requestMore,
    };
    parts.sections.push(requestSection);

    // 各轮摘要（标题与列表内容由 updateDetailsParts 填充）
    const turnSection = textNode("div", "tui-dialog-section");
    const turnTitle = textNode("div", "tui-dialog-section-title");
    const turnList = textNode("div", "tui-dialog-list");
    const turnMore = dialogMoreButton("turns");
    turnSection.append(turnTitle, turnList, turnMore);
    parts.turnList = {
      section: turnSection,
      title: turnTitle,
      list: turnList,
      notice: null,
      rows: [],
      fingerprint: "",
      more: turnMore,
    };
    parts.sections.push(turnSection);

    return parts;
  }

  // 手动启动按钮：复制一条可粘贴到 Win+R 的启动命令（打开确认终端，按 Y 才执行）。
  // 说明：Electron 渲染进程会拦截 tokens-ui-for-codex:// 协议导航（实测 anchor/window.open 均无效），
  // 因此这里采用"复制命令 + 明确指引"的可靠方案；开始菜单入口同样可用。
  function dialogStartButton() {
    const wrap = textNode("div", "tui-dialog-start");
    const button = textNode("button", "tui-dialog-action", "启动监控");
    button.type = "button";
    button.style.cssText =
      "display:block;width:100%;margin-top:8px;padding:8px 10px;font:inherit;font-size:12px;text-align:center;cursor:pointer;color:inherit;background:var(--tui-surface-2,rgba(127,127,127,.10));border:1px solid var(--tui-border,rgba(127,127,127,.28));border-radius:8px;";
    const hint = textNode(
      "div",
      "tui-dialog-start-hint",
      "点击复制启动命令 → Win+R 粘贴回车 → 按 Y 启动（自动关闭终端）",
    );
    hint.style.cssText = "margin-top:6px;font-size:11px;line-height:1.5;text-align:center;opacity:.7;";
    // Win+R 不是 cmd.exe，不能使用 cmd 内建命令 start。
    // explorer.exe 是系统可执行文件，能稳定打开安装器创建的开始菜单快捷方式。
    const command =
      'explorer.exe "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Tokens UI For Codex - 启动监控.lnk"';
    const copyCommand = async () => {
      try {
        await navigator.clipboard.writeText(command);
        return true;
      } catch {}
      try {
        const ta = document.createElement("textarea");
        ta.value = command;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        return true;
      } catch {}
      return false;
    };
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      copyCommand().then((ok) => {
        hint.textContent = ok
          ? "已复制：按 Win+R → Ctrl+V → 回车；按 Y 启动并自动关闭终端"
          : "复制失败：请在开始菜单运行「Tokens UI For Codex - 启动监控」";
        setTimeout(() => {
          hint.textContent = "点击复制启动命令 → Win+R 粘贴回车 → 按 Y 启动（自动关闭终端）";
        }, 6000);
      });
    });
    wrap.append(button, hint);
    return wrap;
  }

  // 「加载更多」宽按钮：撑满列表宽度；点击后扩大推送窗口，由监控按需回推。
  function dialogMoreButton(kind) {
    const button = textNode("button", "tui-dialog-more", "加载更多");
    button.type = "button";
    button.hidden = true;
    button.style.cssText =
      "display:block;width:100%;margin-top:8px;padding:7px 10px;font:inherit;font-size:12px;text-align:center;cursor:pointer;color:inherit;background:var(--tui-surface-2,rgba(127,127,127,.10));border:1px solid var(--tui-border,rgba(127,127,127,.28));border-radius:8px;";
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
      button.textContent = "加载更多";
      button.removeAttribute("title");
      return;
    }
    const atLimit = Number.isFinite(limit) && loaded >= limit;
    button.disabled = atLimit;
    button.textContent = atLimit
      ? "已加载最新 " + fmtInt(loaded) + " " + unit + "（已达上限）"
      : "加载更多（已加载最新 " + fmtInt(loaded) + " / 共 " + fmtInt(total) + " " + unit + "）";
    button.title = atLimit ? "界面最多显示最近 500 " + unit + "；完整结构化记录保存在本地历史文件" : "";
    button.hidden = false;
  }

  // 增量更新：只改文本/宽度，不重建节点。返回 true 表示列表发生了结构重建。
  function updateDetailsParts(parts, data) {
    const m = detailMetrics(data);

    setCellText(parts.session.total, tokenText(data.sessionTotal));
    setCellText(parts.session.requests, fmtInt(data.requestCount));
    updatePairCell(parts.session.pair, m.sessionInput, m.sessionCached);
    setCellText(
      parts.session.tps,
      data.effectiveTps == null ? "-- Tokens/s" : data.effectiveTps.toFixed(1) + " Tokens/s",
    );
    parts.session.tps.title = speedSampleTitle(data);
    setCellText(parts.session.uncached, tokenText(m.sessionUncached));
    setCellText(parts.session.output, tokenText(data.sessionOutput));

    setCellText(parts.turn.total, tokenText(m.turnTotal));
    setCellText(parts.turn.requests, fmtInt(m.currentRequestCount));
    updatePairCell(parts.turn.pair, m.turnInput, m.turnCached);
    setCellText(
      parts.turn.tps,
      data.turnEffectiveTps == null ? "-- Tokens/s" : data.turnEffectiveTps.toFixed(1) + " Tokens/s",
    );
    parts.turn.tps.title = speedSampleTitle(data);
    setCellText(parts.turn.uncached, tokenText(m.turnUncached));
    setCellText(parts.turn.output, tokenText(m.turnOutput));

    setCellText(parts.context.value, tokenText(m.contextUsed));
    setCellText(
      parts.context.limit,
      m.modelContextWindow == null ? "上下文上限未知" : `上限 ${tokenText(m.modelContextWindow)}`,
    );
    const contextPercent = percent(m.contextUsed, m.modelContextWindow);
    const contextWidth = contextPercent == null ? "0%" : `${contextPercent}%`;
    if (parts.context.fill.style.width !== contextWidth) parts.context.fill.style.width = contextWidth;

    const health = data.health || {};
    setCellText(parts.health.status, healthLabel(health));
    setCellText(parts.health.monitor, health.monitorRunning === false ? "未运行" : "运行中");
    setCellText(parts.health.page, health.pageAttached ? "已连接" : "等待连接");
    setCellText(parts.health.data, health.dataFresh ? "最新" : "等待更新");
    setCellText(parts.health.modelSwitches, fmtInt(data.modelSwitchCount) + " 次");
    setCellText(parts.health.resets, fmtInt(data.cumulativeResetCount) + " 次");
    const audit = health.cdpClients;
    const unknownClients = audit && Array.isArray(audit.unknown) ? audit.unknown : [];
    const injection = health.injectionAlert;
    if (parts.security) {
      const notices = [];
      if (unknownClients.length)
        notices.push("检测到 " + unknownClients.length + " 个未知 CDP 客户端（可能也在使用 9229）");
      if (injection && injection.count) notices.push("页面已拒绝 " + injection.count + " 条无效负载");
      if (notices.length) {
        parts.security.box.hidden = false;
        setCellText(parts.security.text, notices.join(" · "));
        const clientKey =
          unknownClients.map((item) => item.name + ":" + item.pid).join(",") + "|" + (injection ? injection.count : 0);
        if (parts.security.key !== clientKey) {
          parts.security.key = clientKey;
          parts.security.list.replaceChildren(
            ...unknownClients.map((item) =>
              textNode(
                "div",
                "tui-dialog-security-row",
                item.name + "  PID " + item.pid + "  ×" + (item.connections || 1),
              ),
            ),
            ...(injection && injection.count
              ? [textNode("div", "tui-dialog-security-row", "被拒绝负载: " + injection.count + " 条")]
              : []),
          );
        }
      } else {
        parts.security.box.hidden = true;
        parts.security.list.hidden = true;
        parts.security.more.textContent = "详情";
      }
    }

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
      keyOf: (request) => request.index,
      buildRow: (request) => buildRequestRow(request),
      updateRow: (row, request) => updateRequestRow(row, request),
    });

    // 倒序展示：最新的一轮在最上面，列表底部是更早的轮次（配合「加载更多」向下翻旧数据）。
    const turns = Array.isArray(data.turns) ? data.turns.slice().reverse() : [];
    const turnTotalCount = data.turnTotalCount != null ? data.turnTotalCount : turns.length;
    setCellText(
      parts.turnList.title,
      data.turnsTruncated ? "各轮摘要（" + fmtInt(turnTotalCount) + " 轮）" : `各轮摘要（${fmtInt(turns.length)} 轮）`,
    );
    updateMoreButton(
      parts.requestList.more,
      !!data.requestDetailsTruncated,
      requests.length,
      data.requestDetailTotal == null ? requests.length : data.requestDetailTotal,
      "条",
      state.requestsLimit,
    );
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
      keyOf: (turn, index) => turn.index || index + 1,
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

  function serviceBadgeText() {
    const badge = document.querySelector(".codex-service-tier-badge");
    if (!badge) return "";
    return String(badge.getAttribute("aria-label") || badge.getAttribute("title") || badge.textContent || "").trim();
  }

  function healthTone(data) {
    if (!data || state.protocolError) return "red";
    const status = data.health && data.health.status;
    if (status === "healthy" && data.health.pageAttached && data.health.dataFresh) return "green";
    if (["failed", "protocol-mismatch", "target-selection-required"].includes(status)) return "red";
    if (
      state.monitorStale ||
      status === "stale-data" ||
      status === "recovering" ||
      (typeof status === "string" && status.startsWith("waiting-"))
    )
      return "yellow";
    return "yellow";
  }

  function updateHealthDot(dot, data) {
    if (!dot) return;
    const tone = healthTone(data);
    dot.className = "tui-dialog-health-dot tui-dialog-health-dot--" + tone;
    dot.title = "运行状态：" + (data ? healthLabel(data.health) : "等待监控数据");
  }

  function formatSubtitle(data) {
    if (!data) return state.protocolError ? "协议不匹配 · 请重新加载 Codex++ 用户脚本" : "等待监控数据";
    const service = serviceBadgeText();
    const prefix = data.snapshot ? "上次数据 · " : "";
    return `${prefix}${healthLabel(data.health)} · ${formatUpdatedAt(data.updatedAt)}${service ? " · " + service : ""}`;
  }

  function speedSampleTitle(data) {
    const count = Number.isFinite(data && data.effectiveSampleCount) ? data.effectiveSampleCount : 0;
    const window = Number.isFinite(data && data.effectiveWindow) ? data.effectiveWindow : 25;
    const confidence = data && data.speedTimingConfidence ? data.speedTimingConfidence : "low";
    const confidenceLabel = confidence === "high" ? "高" : confidence === "medium" ? "中" : "低";
    const compactCount = Number.isFinite(data && data.compactSpeedSampleCount) ? data.compactSpeedSampleCount : 0;
    const compactWindow = Number.isFinite(data && data.compactSpeedWindow) ? data.compactSpeedWindow : 5;
    const compactConfidence = data && data.compactSpeedConfidence ? data.compactSpeedConfidence : "low";
    const compactLabel = compactConfidence === "high" ? "高" : compactConfidence === "medium" ? "中" : "低";
    const compact = Number.isFinite(data && data.compactTps)
      ? `≈${Math.round(data.compactTps)} Tokens/s`
      : "-- Tokens/s";
    const wall = Number.isFinite(data && data.turnWallTps) ? `${data.turnWallTps.toFixed(1)} Tokens/s` : "-- Tokens/s";
    return (
      `有效速度 · 最近 ${count}/${window} 个有效轮次 · 时间置信度 ${confidenceLabel}；` +
      `紧凑条稳健估算 ${compact}（${compactCount}/${compactWindow} 样本，置信度 ${compactLabel}）；` +
      `本轮墙钟平均 ${wall}`
    );
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
      currentRequestCount:
        data && data.currentTurnRequestCount != null
          ? data.currentTurnRequestCount
          : data && data.requestDetailTotal != null
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
    updateHealthDot(dialog.__tuiStatusDot, data);
    dialog.__tuiRenderedDataKey = dataKeyOf(data);

    if (!data) {
      // 无数据：丢弃骨架并显示提示；数据恢复后重建（此路径开销可忽略）。
      dialog.__tuiParts = null;
      body.replaceChildren(
        textNode(
          "div",
          "tui-dialog-notice",
          state.protocolError
            ? "统计协议与监控程序不匹配，请重新加载 Codex++ 用户脚本和监控进程。"
            : "监控数据尚未到达。统计条会在监控进程连接后自动更新。",
        ),
      );
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
    const titleRow = textNode("div", "tui-dialog-title-row");
    const healthDot = textNode("span", "tui-dialog-health-dot tui-dialog-health-dot--yellow");
    healthDot.setAttribute("aria-hidden", "true");
    const title = textNode("div", "tui-dialog-title", "Token 用量详情");
    const subtitle = textNode("div", "tui-dialog-subtitle", "原生统计条 · 仅展示本地脱敏统计");
    titleRow.append(healthDot, title);
    heading.append(titleRow, subtitle);
    title.id = `${DIALOG_ID}-title`;
    subtitle.id = `${DIALOG_ID}-subtitle`;
    const close = textNode("button", "tui-dialog-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭详情");
    close.addEventListener("click", () => closeDetails());
    header.append(heading, close);
    const body = textNode("div", "tui-dialog-body");
    dialog.append(header, body);
    dialog.__tuiBody = body;
    dialog.__tuiSubtitle = subtitle;
    dialog.__tuiStatusDot = healthDot;
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

  // 磨砂玻璃自适应：弹层打开时采样约 0.8 秒帧时间；
  // 若平均帧时间明显超标（<50fps），加 tui-glass-lite 退回实色，避免在低端设备上拖慢流式输出。
  function tuneGlass(dialog) {
    if (!dialog) return;
    if (document.visibilityState !== "visible") return;
    let frames = 0;
    const startedAt = performance.now();
    const tick = () => {
      frames += 1;
      const elapsed = performance.now() - startedAt;
      if (elapsed < 800) {
        requestAnimationFrame(tick);
        return;
      }
      const avg = elapsed / Math.max(1, frames);
      if (avg > 20) dialog.classList.add("tui-glass-lite");
    };
    requestAnimationFrame(tick);
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
    tuneGlass(state.dialog);
    if (state.dialog.__tuiClose && typeof state.dialog.__tuiClose.focus === "function") {
      try {
        state.dialog.__tuiClose.focus({ preventScroll: true });
      } catch {
        state.dialog.__tuiClose.focus();
      }
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
    // 关闭后给监控一个重新推送的宽限期（窗口变化会在 ~1s 内触发推送），
    // 避免把"展开期间没有心跳"误判成监控停止。
    state.lastPayloadAt = Date.now();
    state.monitorStale = false;
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("mousedown", onDocumentPointerDown, true);
    window.removeEventListener("resize", positionDialog);
    window.removeEventListener("scroll", positionDialog, true);
    const dialog = state.dialog;
    const focusTarget = state.previousFocus && state.previousFocus.isConnected ? state.previousFocus : state.root;
    state.dialog = null;
    if (dialog.parentElement) dialog.remove();
    if (state.root) {
      state.root.setAttribute("aria-expanded", "false");
      if (restoreFocus && focusTarget && typeof focusTarget.focus === "function") {
        try {
          focusTarget.focus({ preventScroll: true });
        } catch {
          focusTarget.focus();
        }
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
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    } else {
      const rgb = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(colorText);
      if (!rgb) return null;
      r = Number(rgb[1]);
      g = Number(rgb[2]);
      b = Number(rgb[3]);
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
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (e) {
      return "light";
    }
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
    const candidates = [
      ...document.querySelectorAll(
        '[aria-label*="上下文用量"], [aria-label*="上下文窗口"], [aria-label*="Context usage" i], [aria-label*="Context window" i]',
      ),
    ].filter((node) => {
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

  function render(force = false) {
    if (!state.root) return;
    applyTheme();
    const metrics = state.root.__tuiMetrics;
    const d = state.data;
    const hasData = !!d;
    const renderSignature = [
      dataKeyOf(d),
      state.protocolError,
      state.monitorStale,
      JSON.stringify(d && d.health ? d.health : null),
      d && d.sessionChanged ? "changed" : "",
    ].join("|");
    if (!force && !state.dialog && renderSignature === state.lastRenderSignature) return;
    state.lastRenderSignature = renderSignature;
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

    // 新监控优先使用稳健的中位数估算。字段存在但样本不足时必须显示 --，
    // 不能回退到单条尖峰；只有旧监控完全没有 compactTps 字段时才兼容回退。
    const hasCompactField = hasData && Object.prototype.hasOwnProperty.call(d, "compactTps");
    const estimatedSpeed = hasCompactField
      ? Number.isFinite(d.compactTps)
        ? d.compactTps
        : null
      : hasData && Number.isFinite(d.genEstimateTps)
        ? d.genEstimateTps
        : hasData && Number.isFinite(d.lastRequestTps)
          ? d.lastRequestTps
          : null;
    const tpsText = estimatedSpeed == null ? "--T/s" : "≈" + Math.round(estimatedSpeed) + "T/s";

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
        ? `生成估算速度 ${tpsText}，会话 ${fmtInt(d.sessionTotal)}，当前提问 ${fmtInt(turnTotal)}，请求 ${fmtInt(d.requestCount)}；当前提问命中 ${fmtInt(turnCached)}，未命中 ${fmtInt(turnUncached)}，输出 ${fmtInt(turnOutput)}；会话输入 ${fmtInt(sessionInput)}，命中 ${fmtInt(sessionCached)}，未命中 ${fmtInt(sessionUncached)}，输出 ${fmtInt(d.sessionOutput)}`
        : state.protocolError
          ? "Token 统计协议不匹配"
          : "Token 统计等待监控数据";
      const staleNote = state.monitorStale ? "；监控可能已停止，打开详情可手动启动" : "";
      const accessibleLabel = `${label}${staleNote}；左键查看详细统计`;
      if (state.root.getAttribute("aria-label") !== accessibleLabel)
        state.root.setAttribute("aria-label", accessibleLabel);
      state.root.title = accessibleLabel;
      state.root.classList.toggle(
        "tui-native-stale",
        !hasData || state.monitorStale || !!(d && d.health && d.health.status !== "healthy"),
      );
      state.root.classList.toggle(
        "tui-native-error",
        !!state.protocolError ||
          !!(d && d.health && ["failed", "protocol-mismatch", "target-selection-required"].includes(d.health.status)),
      );
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
          "[Tokens UI For Codex] 统计条未挂载: " +
            reason +
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

    if (!state.root) {
      state.root = buildRoot();
      state.lastRenderSignature = "";
    }
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
    const alreadyPlaced =
      state.root.parentElement === point.container &&
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
        try {
          point.container.appendChild(state.root);
        } catch {}
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
        if (state.container && (record.target === state.container || state.container.contains(record.target)))
          return true;
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
                !!(
                  node.querySelector &&
                  node.querySelector(
                    '[aria-label*="上下文用量"], [aria-label*="上下文窗口"], [aria-label*="Context usage" i], [aria-label*="Context window" i]',
                  )
                ))
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
    // 主题观察单独挂在 <html> 上，不订阅整棵子树的 class/style，
    // 避免宿主频繁更新普通元素时让插件做无意义的全树回调。
    state.themeObserver = new MutationObserver(() => {
      clearTimeout(state.themeTimer);
      state.themeTimer = setTimeout(applyTheme, 30);
    });
    state.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-color-scheme", "class", "style"],
    });
    try {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const onThemePreference = () => {
        clearTimeout(state.themeTimer);
        state.themeTimer = setTimeout(applyTheme, 30);
      };
      if (typeof media.addEventListener === "function") media.addEventListener("change", onThemePreference);
      else if (typeof media.addListener === "function") media.addListener(onThemePreference);
      state.themeMedia = media;
    } catch {}
    window.addEventListener("resize", updateDensity, { passive: true });
  }

  // ---- 负载验签（HMAC + nonce + 时间窗 + seq）---------------------------
  // schema v3 是严格的签名-only 协议：boot 负载也必须验签。
  // 监控用会话级密钥签名，密钥经 CDP 注入；任何缺 auth、坏 MAC、过期、
  // nonce 重放或 seq 倒退的负载都不会进入 adoptData()。
  const seenNonces = new Set();
  let rejectedPayloads = 0;
  let lastAuthKey = "";
  let lastAuthSeq = 0;
  let dataEventSeq = 0;
  const hmacKeyCache = new Map();

  function canonicalJson(value) {
    if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
    if (value && typeof value === "object") {
      return (
        "{" +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
          .join(",") +
        "}"
      );
    }
    return JSON.stringify(value);
  }

  async function hmacHex(key, text) {
    let imported = hmacKeyCache.get(key);
    if (!imported) {
      imported = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      hmacKeyCache.set(key, imported);
    }
    const signature = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(text));
    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function verifyPayloadAuth(data) {
    if (!data || typeof data !== "object") return { ok: false, reason: "no-data" };
    if (data.authRequired !== true) return { ok: false, reason: "auth-required" };
    const auth = data.auth;
    if (!auth || typeof auth !== "object") return { ok: false, reason: "unsigned" };
    if (auth.v !== 1) return { ok: false, reason: "auth-version" };
    const key = window.__tuiForCodexAuthKey;
    if (typeof key !== "string" || !key) return { ok: false, reason: "no-key" };
    // 监控重启会轮换密钥：新会话开始时清零上次会话的拒绝计数，
    // 否则 data-tui-security 会一直把旧告警带回来。
    if (key !== lastAuthKey) {
      lastAuthKey = key;
      rejectedPayloads = 0;
      seenNonces.clear();
      lastAuthSeq = 0;
      document.documentElement.setAttribute("data-tui-security", "0");
    }
    const ts = Number(auth.ts);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 30000) return { ok: false, reason: "stale" };
    if (!Number.isInteger(auth.seq) || auth.seq < 1 || auth.seq <= lastAuthSeq)
      return { ok: false, reason: "sequence" };
    if (!auth.nonce || seenNonces.has(auth.nonce)) return { ok: false, reason: "replay" };
    const body = { ...data };
    delete body.auth;
    const expected = await hmacHex(key, canonicalJson(body) + "|" + ts + "|" + auth.nonce);
    if (typeof auth.mac !== "string" || expected.length !== auth.mac.length) return { ok: false, reason: "mac" };
    let diff = 0;
    for (let index = 0; index < expected.length; index += 1) {
      diff |= expected.charCodeAt(index) ^ auth.mac.charCodeAt(index);
    }
    if (diff !== 0) return { ok: false, reason: "mac" };
    seenNonces.add(auth.nonce);
    if (seenNonces.size > 512) seenNonces.delete(seenNonces.values().next().value);
    lastAuthSeq = auth.seq;
    return { ok: true };
  }

  function clonePayload(data) {
    if (data == null) return null;
    try {
      return structuredClone(data);
    } catch {
      return JSON.parse(JSON.stringify(data));
    }
  }

  // 数据事件：监控进程写入 window.__tuiForCodex 后派发 tokens-ui-for-codex。
  const handleDataEvent = async () => {
    const seq = ++dataEventSeq;
    // 先深拷贝再做异步 WebCrypto 验签；验证与应用必须是同一份不可变快照。
    const nextData = clonePayload(window.__tuiForCodex || null);
    const verdict = await verifyPayloadAuth(nextData);
    if (seq !== dataEventSeq) return;
    if (!verdict.ok) {
      rejectedPayloads += 1;
      document.documentElement.setAttribute("data-tui-security", String(rejectedPayloads));
      return;
    }
    adoptData(nextData);
    // 收到任何推送（含 1s/5s 心跳）即刷新"监控存活"时间
    state.lastPayloadAt = Date.now();
    state.monitorStale = false;
    // 每次数据事件都渲染：内部全部是增量更新（实测 <1ms，最低成本已做 !== 检查）。
    // 不再用 dataKey 门控 —— 它曾漏掉 sessionTps / lastRequestTps / health 等字段，
    // 导致「速度或健康状态变化但界面不刷新」（P4）；去掉字段清单依赖后，
    // 未来新增字段也不会再漏，代价只是空闲时每 5 秒一次的空跑。
    render();
    if (!state.root || !state.root.isConnected) queueMount();
  };
  window.addEventListener(DATA_EVENT, handleDataEvent);

  const bootPayload = clonePayload(window.__tuiForCodex || null);
  if (bootPayload) {
    const bootSeq = ++dataEventSeq;
    verifyPayloadAuth(bootPayload).then((verdict) => {
      if (bootSeq !== dataEventSeq) return;
      if (!verdict.ok) {
        rejectedPayloads += 1;
        document.documentElement.setAttribute("data-tui-security", String(rejectedPayloads));
        return;
      }
      adoptData(bootPayload);
      state.lastPayloadAt = Date.now();
    });
  }

  const start = () => {
    installObservers();
    // 折叠态陈旧检测：90 秒没收到任何推送（空闲心跳 5 秒一次）→ 视为监控可能已停止。
    // 展开态不做心跳（仅数据变化才推），因此弹层打开时跳过判断，避免误报。
    setInterval(() => {
      if (state.dialog) return;
      if (!state.lastPayloadAt) return;
      const stale = Date.now() - state.lastPayloadAt > 90000;
      if (stale !== state.monitorStale) {
        state.monitorStale = stale;
        render();
      }
    }, 30000);
    // 初始挂载统一走 queueMount：与后续重挂载共用同一层异常保护与诊断状态。
    // 直接调用 mount() 时，初始异常只是一条裸的未捕获错误、且不写诊断状态，
    // 排障时无法区分「锚点缺失（Codex 改版）」与「插件自身抛错」。
    queueMount();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();

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
  window.__ccmTokenSpendProtocol = {
    protocolName: PROTOCOL_NAME,
    protocolVersion: PROTOCOL_SCHEMA_VERSION,
    supportedSchemaVersions: [PROTOCOL_SCHEMA_VERSION],
    capabilities: PROTOCOL_CAPABILITIES.slice(),
  };
  const INSTALL_FLAG = "__ccmTokenSpendNativeUiInstalled";
  if (window[INSTALL_FLAG]) return;
  window[INSTALL_FLAG] = true;

  const ROOT_ID = "ccm-token-spend-native";
  const STYLE_ID = "ccm-token-spend-native-style";
  const DIALOG_ID = "ccm-token-spend-detail-dialog";
  const DATA_EVENT = "ccm-token-spend";
  const LEGACY_IDS = ["ccm-token-spend-panel", "ccm-token-spend-mini", "ccm-token-spend-style"];

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
  };

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
    for (const key of ["sessionTotal", "contextUsed", "modelContextWindow", "sessionInput", "sessionCached", "sessionOutput", "turnCached"]) {
      if (!isNullableNonNegativeNumber(data[key])) return { ok: false, error: `${key} 字段无效` };
    }
    if (!Array.isArray(data.turns) || data.turns.length > 200) return { ok: false, error: "轮次摘要超出限制" };
    if (!Array.isArray(data.requestDetails) || data.requestDetails.length > 100) return { ok: false, error: "请求明细超出限制" };
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

  function removeLegacyPanel() {
    for (const id of LEGACY_IDS) {
      const node = document.getElementById(id);
      if (node) node.remove();
    }
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
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
  color: var(--color-text-secondary, var(--color-text, currentColor));
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
#${ROOT_ID}:hover { background: var(--color-background-hover, rgba(127, 127, 127, .12)); }
#${ROOT_ID}:focus-visible {
  outline: 2px solid var(--color-accent, var(--color-primary, #6ea8fe));
  outline-offset: 2px;
}
#${ROOT_ID} .ccm-ts-native-primary,
#${ROOT_ID} .ccm-ts-native-secondary {
  display: flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${ROOT_ID} .ccm-ts-native-primary {
  color: var(--color-text, currentColor);
  font-size: 11px;
  font-weight: 500;
}
#${ROOT_ID} .ccm-ts-native-secondary {
  color: var(--color-text-tertiary, var(--color-text-secondary, currentColor));
  font-size: 10px;
  line-height: 12px;
  opacity: .9;
}
#${ROOT_ID} .ccm-ts-native-metric {
  display: inline-flex;
  min-width: 0;
  align-items: baseline;
  gap: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${ROOT_ID} .ccm-ts-native-label { opacity: .72; }
#${ROOT_ID} .ccm-ts-native-value { font-variant-numeric: tabular-nums; }
#${ROOT_ID}.ccm-ts-native-compact .ccm-ts-native-label { display: none; }
#${ROOT_ID}.ccm-ts-native-compact { max-width: min(280px, 42vw); }
#${ROOT_ID}.ccm-ts-native-stale { opacity: .62; }
#${ROOT_ID}.ccm-ts-native-error { color: var(--color-danger, var(--color-text-danger, #c0392b)); }
#${DIALOG_ID} {
  position: fixed;
  z-index: 2147483000;
  display: none;
  width: min(440px, calc(100vw - 24px));
  max-height: min(560px, calc(100vh - 24px));
  flex-direction: column;
  overflow: hidden;
  color: var(--color-text, var(--text-primary, #1f2328));
  background: var(--color-background-primary, var(--background-primary, #ffffff));
  border: 1px solid var(--color-border, var(--border-color, rgba(127, 127, 127, .28)));
  border-radius: 12px;
  box-shadow: 0 16px 42px rgba(0, 0, 0, .22), 0 3px 12px rgba(0, 0, 0, .14);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.4;
}
#${DIALOG_ID}[data-open="true"] { display: flex; }
#${DIALOG_ID} .ccm-ts-dialog-header {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--color-border, var(--border-color, rgba(127, 127, 127, .2)));
}
#${DIALOG_ID} .ccm-ts-dialog-title { font-size: 14px; font-weight: 650; }
#${DIALOG_ID} .ccm-ts-dialog-subtitle {
  margin-top: 2px;
  color: var(--color-text-tertiary, var(--color-text-secondary, currentColor));
  font-size: 11px;
}
#${DIALOG_ID} .ccm-ts-dialog-close {
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
#${DIALOG_ID} .ccm-ts-dialog-close:hover,
#${DIALOG_ID} .ccm-ts-dialog-close:focus-visible {
  color: var(--color-text, currentColor);
  background: var(--color-background-hover, rgba(127, 127, 127, .14));
  outline: none;
}
#${DIALOG_ID} .ccm-ts-dialog-body {
  min-height: 0;
  padding: 12px 16px 16px;
  overflow: auto;
  scrollbar-width: thin;
}
#${DIALOG_ID} .ccm-ts-dialog-section { margin: 0 0 14px; }
#${DIALOG_ID} .ccm-ts-dialog-section:last-child { margin-bottom: 0; }
#${DIALOG_ID} .ccm-ts-dialog-section-title {
  margin-bottom: 8px;
  color: var(--color-text-secondary, currentColor);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: .02em;
  text-transform: uppercase;
}
#${DIALOG_ID} .ccm-ts-dialog-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
#${DIALOG_ID} .ccm-ts-dialog-card {
  min-width: 0;
  padding: 9px 10px;
  background: var(--color-background-secondary, rgba(127, 127, 127, .08));
  border: 1px solid var(--color-border, var(--border-color, rgba(127, 127, 127, .16)));
  border-radius: 8px;
}
#${DIALOG_ID} .ccm-ts-dialog-card-label {
  color: var(--color-text-tertiary, var(--color-text-secondary, currentColor));
  font-size: 10px;
}
#${DIALOG_ID} .ccm-ts-dialog-card-value {
  margin-top: 2px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
#${DIALOG_ID} .ccm-ts-dialog-card-note {
  margin-top: 2px;
  color: var(--color-text-tertiary, var(--color-text-secondary, currentColor));
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${DIALOG_ID} .ccm-ts-dialog-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  border-bottom: 1px solid var(--color-border, var(--border-color, rgba(127, 127, 127, .12)));
}
#${DIALOG_ID} .ccm-ts-dialog-row:last-child { border-bottom: 0; }
#${DIALOG_ID} .ccm-ts-dialog-row-label { color: var(--color-text-secondary, currentColor); }
#${DIALOG_ID} .ccm-ts-dialog-row-value {
  font-variant-numeric: tabular-nums;
  font-weight: 550;
  text-align: right;
}
#${DIALOG_ID} .ccm-ts-dialog-context {
  padding: 10px;
  background: var(--color-background-secondary, rgba(127, 127, 127, .08));
  border-radius: 8px;
}
#${DIALOG_ID} .ccm-ts-dialog-context-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
#${DIALOG_ID} .ccm-ts-dialog-context-value { font-variant-numeric: tabular-nums; font-weight: 600; }
#${DIALOG_ID} .ccm-ts-dialog-context-bar {
  height: 6px;
  margin-top: 8px;
  overflow: hidden;
  background: var(--color-background-tertiary, rgba(127, 127, 127, .16));
  border-radius: 999px;
}
#${DIALOG_ID} .ccm-ts-dialog-context-fill {
  width: 0;
  height: 100%;
  background: var(--color-accent, var(--color-primary, #6ea8fe));
  border-radius: inherit;
  transition: width .16s ease;
}
#${DIALOG_ID} .ccm-ts-dialog-list {
  overflow: hidden;
  border: 1px solid var(--color-border, var(--border-color, rgba(127, 127, 127, .16)));
  border-radius: 8px;
}
#${DIALOG_ID} .ccm-ts-dialog-list-item {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--color-border, var(--border-color, rgba(127, 127, 127, .12)));
}
#${DIALOG_ID} .ccm-ts-dialog-list-item:last-child { border-bottom: 0; }
#${DIALOG_ID} .ccm-ts-dialog-list-item-current { background: var(--color-background-secondary, rgba(127, 127, 127, .08)); }
#${DIALOG_ID} .ccm-ts-dialog-list-index {
  color: var(--color-text-tertiary, var(--color-text-secondary, currentColor));
  font-variant-numeric: tabular-nums;
  font-size: 10px;
}
#${DIALOG_ID} .ccm-ts-dialog-list-main { min-width: 0; }
#${DIALOG_ID} .ccm-ts-dialog-list-title { font-weight: 550; }
#${DIALOG_ID} .ccm-ts-dialog-list-note {
  margin-top: 1px;
  color: var(--color-text-tertiary, var(--color-text-secondary, currentColor));
  font-size: 10px;
}
#${DIALOG_ID} .ccm-ts-dialog-list-total { font-variant-numeric: tabular-nums; font-weight: 550; text-align: right; }
#${DIALOG_ID} .ccm-ts-dialog-muted {
  color: var(--color-text-tertiary, var(--color-text-secondary, currentColor));
  font-size: 11px;
}
#${DIALOG_ID} .ccm-ts-dialog-notice {
  margin: 0 0 12px;
  padding: 8px 10px;
  color: var(--color-text-secondary, currentColor);
  background: var(--color-background-secondary, rgba(127, 127, 127, .08));
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
    span.className = "ccm-ts-native-metric " + className;
    const labelNode = document.createElement("span");
    labelNode.className = "ccm-ts-native-label";
    labelNode.textContent = label;
    const valueNode = document.createElement("span");
    valueNode.className = "ccm-ts-native-value";
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
    primary.className = "ccm-ts-native-primary";
    const session = makeMetric("会话", "ccm-ts-native-session");
    const turn = makeMetric("当前提问", "ccm-ts-native-turn");
    const requests = makeMetric("请求", "ccm-ts-native-requests");
    primary.append(session.span, turn.span, requests.span);

    const secondary = document.createElement("span");
    secondary.className = "ccm-ts-native-secondary";
    const cached = makeMetric("命中", "ccm-ts-native-cached");
    const uncached = makeMetric("未命中", "ccm-ts-native-uncached");
    const output = makeMetric("输出", "ccm-ts-native-output");
    secondary.append(cached.span, uncached.span, output.span);

    root.append(primary, secondary);
    root.__ccmMetrics = { session, turn, requests, cached, uncached, output };
    root.addEventListener("click", (event) => {
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      openDetails();
    });
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openDetails();
    });
    return root;
  }

  function dialogSection(title, content) {
    const section = textNode("section", "ccm-ts-dialog-section");
    section.append(textNode("div", "ccm-ts-dialog-section-title", title), content);
    return section;
  }

  function dialogCard(label, value, note) {
    const card = textNode("div", "ccm-ts-dialog-card");
    card.append(textNode("div", "ccm-ts-dialog-card-label", label));
    card.append(textNode("div", "ccm-ts-dialog-card-value", value));
    if (note) card.append(textNode("div", "ccm-ts-dialog-card-note", note));
    return card;
  }

  function dialogGrid(items) {
    const grid = textNode("div", "ccm-ts-dialog-grid");
    for (const item of items) grid.append(dialogCard(item[0], item[1], item[2]));
    return grid;
  }

  function dialogList(items, renderItem) {
    const list = textNode("div", "ccm-ts-dialog-list");
    if (!items.length) {
      list.append(textNode("div", "ccm-ts-dialog-muted", "暂无可展示的数据"));
      return list;
    }
    for (let index = 0; index < items.length; index += 1) {
      list.append(renderItem(items[index], index));
    }
    return list;
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

  function renderDetails() {
    if (!state.dialog || !state.dialog.__ccmBody) return;
    const body = state.dialog.__ccmBody;
    const data = state.data;
    if (state.dialog.__ccmSubtitle) state.dialog.__ccmSubtitle.textContent = formatSubtitle(data);
    state.dialog.__ccmRenderedDataKey = dataKeyOf(data);
    body.replaceChildren();
    if (!data) {
      body.append(textNode("div", "ccm-ts-dialog-notice", state.protocolError
        ? "统计协议与监控程序不匹配，请重新加载 Codex++ 用户脚本和监控进程。"
        : "监控数据尚未到达。统计条会在监控进程连接后自动更新。"));
      return;
    }

    const m = detailMetrics(data);
    const sessionTotal = data.sessionTotal;
    const sessionOutput = data.sessionOutput;
    const turns = Array.isArray(data.turns) ? data.turns : [];
    const requests = Array.isArray(data.requestDetails) ? data.requestDetails : [];

    body.append(dialogSection("会话累计", dialogGrid([
      ["总量", tokenText(sessionTotal)],
      ["请求", fmtInt(data.requestCount)],
      ["输入", tokenText(m.sessionInput)],
      ["缓存命中", tokenText(m.sessionCached)],
      ["缓存未命中", tokenText(m.sessionUncached)],
      ["输出", tokenText(sessionOutput)],
    ])));

    body.append(dialogSection("当前提问统计", dialogGrid([
      ["总量", tokenText(m.turnTotal)],
      ["请求", fmtInt(m.currentRequestCount)],
      ["输入", tokenText(m.turnInput)],
      ["缓存命中", tokenText(m.turnCached)],
      ["缓存未命中", tokenText(m.turnUncached)],
      ["输出", tokenText(m.turnOutput)],
    ])));

    const context = textNode("div", "ccm-ts-dialog-context");
    const contextTop = textNode("div", "ccm-ts-dialog-context-top");
    contextTop.append(
      textNode("span", "ccm-ts-dialog-context-value", tokenText(m.contextUsed)),
      textNode("span", "ccm-ts-dialog-muted", m.modelContextWindow == null ? "上下文上限未知" : `上限 ${tokenText(m.modelContextWindow)}`),
    );
    const contextBar = textNode("div", "ccm-ts-dialog-context-bar");
    const contextFill = textNode("div", "ccm-ts-dialog-context-fill");
    const contextPercent = percent(m.contextUsed, m.modelContextWindow);
    contextFill.style.width = contextPercent == null ? "0%" : `${contextPercent}%`;
    contextBar.append(contextFill);
    context.append(contextTop, contextBar);
    body.append(dialogSection("上下文使用", context));

    const health = data.health || {};
    body.append(dialogSection("运行状态", dialogGrid([
      ["状态", healthLabel(health)],
      ["监控", health.monitorRunning === false ? "未运行" : "运行中"],
      ["页面连接", health.pageAttached ? "已连接" : "等待连接"],
      ["数据", health.dataFresh ? "最新" : "等待更新"],
      ["窗口选择", health.targetSelection === "required" ? "需要指定窗口" : (health.targetSelection || "自动")],
      ["模型切换", fmtInt(data.modelSwitchCount) + " 次"],
      ["累计重置", fmtInt(data.cumulativeResetCount) + " 次"],
      ["恢复", health.recoveryState === "recovered" ? "已恢复" : (health.recoveryState || "正常")],
    ])));

    const requestSection = textNode("div", "ccm-ts-dialog-section");
    requestSection.append(textNode("div", "ccm-ts-dialog-section-title", "当前提问请求明细"));
    if (data.requestDetailsTruncated) {
      requestSection.append(textNode("div", "ccm-ts-dialog-notice", `当前提问共 ${fmtInt(data.requestDetailTotal)} 次请求，页面展示最近 100 条。`));
    }
    requestSection.append(dialogList(requests, (request) => {
      const row = textNode("div", "ccm-ts-dialog-list-item");
      const index = request.index || "--";
      const main = textNode("div", "ccm-ts-dialog-list-main");
      main.append(
        textNode("div", "ccm-ts-dialog-list-title", `第 ${index} 次请求`),
        textNode("div", "ccm-ts-dialog-list-note", `${request.time || "时间未知"} · 输入 ${fmtShort(request.input)} · 命中 ${fmtShort(request.cached)} · 未命中 ${fmtShort(request.uncached)} · 输出 ${fmtShort(request.output)}`),
      );
      row.append(
        textNode("div", "ccm-ts-dialog-list-index", `#${index}`),
        main,
        textNode("div", "ccm-ts-dialog-list-total", fmtShort(request.total)),
      );
      return row;
    }));
    body.append(requestSection);

   const turnSection = textNode("div", "ccm-ts-dialog-section");
   turnSection.append(textNode("div", "ccm-ts-dialog-section-title", `各轮摘要（${fmtInt(turns.length)} 轮）`));
    const turnTotalCount = data.turnTotalCount != null ? data.turnTotalCount : turns.length;
    if (data.turnsTruncated) {
      turnSection.firstChild.textContent = "各轮摘要（" + fmtInt(turnTotalCount) + " 轮）";
      turnSection.append(textNode("div", "ccm-ts-dialog-notice", "会话共 " + fmtInt(turnTotalCount) + " 轮，页面展示最近 200 轮。"));
    }
    turnSection.append(dialogList(turns, (turn, index) => {
      const current = index === turns.length - 1;
      const row = textNode("div", "ccm-ts-dialog-list-item" + (current ? " ccm-ts-dialog-list-item-current" : ""));
      const main = textNode("div", "ccm-ts-dialog-list-main");
      const label = current ? `第 ${turn.index || index + 1} 轮 · 当前` : `第 ${turn.index || index + 1} 轮`;
      main.append(
        textNode("div", "ccm-ts-dialog-list-title", label),
        textNode("div", "ccm-ts-dialog-list-note", `${turn.startLabel || "时间未知"} · ${fmtInt(turn.requests)} 次请求 · 输入 ${fmtShort(turn.input)} · 输出 ${fmtShort(turn.output)}`),
      );
      row.append(
        textNode("div", "ccm-ts-dialog-list-index", `T${turn.index || index + 1}`),
        main,
        textNode("div", "ccm-ts-dialog-list-total", fmtShort(turn.total)),
      );
      return row;
    }));
    body.append(turnSection);
  }

  function buildDialog() {
    const dialog = textNode("div", "ccm-ts-dialog");
    dialog.id = DIALOG_ID;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "false");
    dialog.setAttribute("aria-labelledby", `${DIALOG_ID}-title`);
    dialog.setAttribute("aria-describedby", `${DIALOG_ID}-subtitle`);
    const header = textNode("div", "ccm-ts-dialog-header");
    const heading = textNode("div");
    heading.append(
      textNode("div", "ccm-ts-dialog-title", "Token 用量详情"),
      textNode("div", "ccm-ts-dialog-subtitle", "原生统计条 · 仅展示本地脱敏统计"),
    );
    heading.firstChild.id = `${DIALOG_ID}-title`;
    heading.lastChild.id = `${DIALOG_ID}-subtitle`;
    const close = textNode("button", "ccm-ts-dialog-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭详情");
    close.addEventListener("click", () => closeDetails());
    header.append(heading, close);
    const body = textNode("div", "ccm-ts-dialog-body");
    dialog.append(header, body);
   dialog.__ccmBody = body;
   dialog.__ccmSubtitle = heading.lastChild;
    dialog.__ccmClose = close;
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

  // 点击外部关闭：这是主要的关闭方式（宿主会拦截 Escape，不能作为唯一依赖）。
  function onDocumentPointerDown(event) {
    if (!state.dialog) return;
    const target = event.target;
    if (state.dialog.contains(target)) return;
    if (state.root && state.root.contains(target)) return;
    closeDetails();
  }

  function onDocumentKeydown(event) {
    // 兼容不同内核/输入法的键名；不阻断 Codex 自身的按键处理，只做关闭。
    if (event.key !== "Escape" && event.key !== "Esc") return;
    if (!state.dialog) return;
    event.preventDefault();
    closeDetails();
  }

  function openDetails() {
    if (!document.body) return;
    if (state.dialog && state.dialog.getAttribute("data-open") === "true") return;
    if (!state.dialog) {
      state.previousFocus = document.activeElement;
      state.dialog = buildDialog();
      document.body.appendChild(state.dialog);
    }
    state.dialog.setAttribute("data-open", "true");
    state.dialog.style.visibility = "hidden";
    state.root && state.root.setAttribute("aria-expanded", "true");
    renderDetails();
    positionDialog();
   state.dialog.style.visibility = "visible";
    if (state.dialog.__ccmClose && typeof state.dialog.__ccmClose.focus === "function") {
      try { state.dialog.__ccmClose.focus({ preventScroll: true }); } catch { state.dialog.__ccmClose.focus(); }
    }
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    // mousedown 兜底：个别环境不派发 PointerEvent 时仍能点击外部关闭。
    document.addEventListener("mousedown", onDocumentPointerDown, true);
    // Escape 仅作增强：Codex 宿主可能先消费该按键，点击外部与关闭按钮始终可用。
    window.addEventListener("keydown", onDocumentKeydown, true);
    window.addEventListener("keyup", onDocumentKeydown, true);
    document.addEventListener("keydown", onDocumentKeydown, true);
    document.addEventListener("keyup", onDocumentKeydown, true);
    window.addEventListener("resize", positionDialog, { passive: true });
    window.addEventListener("scroll", positionDialog, { passive: true, capture: true });
    requestAnimationFrame(positionDialog);
  }

  function closeDetails({ restoreFocus = true } = {}) {
    if (!state.dialog) return;
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    document.removeEventListener("mousedown", onDocumentPointerDown, true);
    window.removeEventListener("keydown", onDocumentKeydown, true);
    window.removeEventListener("keyup", onDocumentKeydown, true);
    document.removeEventListener("keydown", onDocumentKeydown, true);
    document.removeEventListener("keyup", onDocumentKeydown, true);
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
    const metrics = state.root.__ccmMetrics;
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

    setMetric(metrics.session, hasData ? fmtShort(d.sessionTotal) : "--");
    setMetric(metrics.turn, hasData ? fmtShort(turnTotal) : "--");
    setMetric(metrics.requests, hasData ? fmtInt(d.requestCount) : "--");
    setMetric(metrics.cached, hasData ? fmtShort(turnCached) : "--");
    setMetric(metrics.uncached, hasData ? fmtShort(turnUncached) : "--");
    setMetric(metrics.output, hasData ? fmtShort(turnOutput) : "--");

    const sessionSplit = cacheSplit(d && d.sessionInput, d && d.sessionCached);
    const sessionInput = sessionSplit.input;
    const sessionCached = sessionSplit.cached;
    const sessionUncached = sessionSplit.uncached;
    const label = hasData
      ? `会话 ${fmtInt(d.sessionTotal)}，当前提问 ${fmtInt(turnTotal)}，请求 ${fmtInt(d.requestCount)}；当前提问命中 ${fmtInt(turnCached)}，未命中 ${fmtInt(turnUncached)}，输出 ${fmtInt(turnOutput)}；会话输入 ${fmtInt(sessionInput)}，命中 ${fmtInt(sessionCached)}，未命中 ${fmtInt(sessionUncached)}，输出 ${fmtInt(d.sessionOutput)}`
      : state.protocolError ? "Token 统计协议不匹配" : "Token 统计等待监控数据";
    const accessibleLabel = `${label}；左键查看详细统计`;
    if (state.root.getAttribute("aria-label") !== accessibleLabel) state.root.setAttribute("aria-label", accessibleLabel);
    state.root.title = accessibleLabel;
    state.root.classList.toggle("ccm-ts-native-stale", !hasData || !!(d && d.health && d.health.status !== "healthy"));
    state.root.classList.toggle("ccm-ts-native-error", !!state.protocolError || !!(d && d.health && ["failed", "protocol-mismatch", "target-selection-required"].includes(d.health.status)));
    if (state.dialog) {
      if (state.dialog.__ccmRenderedDataKey !== dataKeyOf(state.data)) {
        renderDetails();
      } else if (state.dialog.__ccmSubtitle) {
        state.dialog.__ccmSubtitle.textContent = formatSubtitle(state.data);
      }
      positionDialog();
    }
  }

  function updateDensity() {
    if (!state.root || !state.container) return;
    const width = state.container.getBoundingClientRect().width;
    state.root.classList.toggle("ccm-ts-native-compact", width < 420 || window.innerWidth < 900);
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
    removeLegacyPanel();

    const ring = findContextRing();
    const point = ring ? findMountPoint(ring) : null;
    if (!point) {
      if (state.dialog) closeDetails({ restoreFocus: false });
      if (state.root) state.root.remove();
      state.root = null;
      state.container = null;
      if (state.resizeObserver) state.resizeObserver.disconnect();
      return;
    }

    if (!state.root) state.root = buildRoot();
    if (state.root.parentElement !== point.container || state.root.nextSibling !== point.before) {
      point.container.insertBefore(state.root, point.before);
    }
    observeContainer(point.container);
    render();
  }

  function queueMount() {
    if (state.mountQueued) return;
    state.mountQueued = true;
    requestAnimationFrame(mount);
  }

  function installObservers() {
    if (state.mutationObserver || !document.documentElement) return;
    state.mutationObserver = new MutationObserver((records) => {
      const needsMount = records.some((record) => {
        if (!state.root || !state.root.isConnected) return true;
        if (state.root && (record.target === state.root || state.root.contains(record.target))) return false;
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
            return (typeof label === "string" && /上下文用量|上下文窗口|context usage|context window/i.test(label)) ||
              !!(node.querySelector && node.querySelector('[aria-label*="上下文用量"], [aria-label*="上下文窗口"], [aria-label*="Context usage" i], [aria-label*="Context window" i]'));
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

  window.addEventListener(DATA_EVENT, () => {
    const nextData = window.__ccmTokenSpend || null;
    const previousKey = state.dataKey;
    const previousError = state.protocolError;
    adoptData(nextData);
    const changed = state.dataKey !== previousKey || state.protocolError !== previousError;
    if (changed) render();
    else if (state.dialog && state.dialog.__ccmSubtitle) {
      state.dialog.__ccmSubtitle.textContent = formatSubtitle(state.data);
    }
    if (!state.root || !state.root.isConnected) queueMount();
  });

  if (window.__ccmTokenSpend) {
    adoptData(window.__ccmTokenSpend);
  }

  const start = () => {
    installObservers();
    mount();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();

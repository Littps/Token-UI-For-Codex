// 实机 UI 测试：通过 Playwright 以 CDP 方式连接正在运行的 Codex 桌面版。
// 运行：node --test --test-force-exit test/live-ui.playwright.test.mjs
//
// 安全约定：
// 1. 不调用 browser.close()，避免关闭用户正在使用的 Codex 窗口。
// 2. 真实键鼠注入默认跳过（Escape 会被 Codex 当作“停止回答”），
//    只有显式设置 TUI_ALLOW_REAL_INPUT=1 时才执行。
// 3. 关闭方式以“点击外部 / 右上角 ×”为主路径，Esc 仅作增强验证。

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";
import { resolveCdpPort } from "../scripts/cdp-port.mjs";

const require = createRequire(import.meta.url);
const globalNodeModules = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules");

function loadPlaywright() {
  for (const candidate of ["playwright", "playwright-core", path.join(globalNodeModules, "playwright")]) {
    try {
      return require(candidate);
    } catch {}
  }
  throw new Error("无法加载 Playwright；请先安装：npm i -g playwright");
}

const { chromium } = loadPlaywright();
const cdpPort = await resolveCdpPort(process.env.TUI_CDP_PORT || "auto");
const CDP_ENDPOINT = process.env.TUI_CDP_URL || "http://127.0.0.1:" + cdpPort;
const PANEL_SELECTOR = "#tui-native";
const ALLOW_REAL_INPUT = process.env.TUI_ALLOW_REAL_INPUT === "1";
const realInputSkip = ALLOW_REAL_INPUT
  ? false
  : "默认跳过真实输入注入：Escape 会被 Codex 当作“停止回答”，需要显式设置 TUI_ALLOW_REAL_INPUT=1";

const PAYLOAD_WHITELIST = new Set([
  "protocolName",
  "schemaVersion",
  "authRequired",
  "capabilities",
  "auth",
  "modelContextWindow",
  "requestCount",
  "currentTurnRequestCount",
  "sessionTotal",
  "sessionInput",
  "sessionCached",
  "sessionOutput",
  "sessionCacheHitRate",
  "sessionTps",
  "genEstimateTps",
  "compactTps",
  "compactSpeedSampleCount",
  "compactSpeedConfidence",
  "compactSpeedWindow",
  "turnWallTps",
  "effectiveTps",
  "turnEffectiveTps",
  "effectiveSampleCount",
  "effectiveWindow",
  "speedTimingConfidence",
  "contextUsed",
  "contextBreakdown",
  "sessionWallMs",
  "sessionToolWallMs",
  "sessionToolCallCount",
  "sessionTtftAvgMs",
  "sessionTimingSampleCount",
  "rangeSummary",
  "modelUsage",
  "pricing",
  "turnTotal",
  "turnInput",
  "turnWallMs",
  "turnToolWallMs",
  "turnToolCallCount",
  "turnTtftMs",
  "turnTimingCoverage",
  "turnTimingQuality",
  "turnCached",
  "turnOutput",
  "turnCacheHitRate",
  "lastRequestTps",
  "turnTps",
  "turnsLimit",
  "requestsLimit",
  "sessionChanged",
  "currentTurnIndex",
  "turns",
  "turnsTruncated",
  "turnTotalCount",
  "requestDetails",
  "requestDetailsTruncated",
  "requestDetailTotal",
  "snapshot",
  "modelSwitchCount",
  "cumulativeResetCount",
  "health",
  "updatedAt",
]);

const state = { browser: null, page: null };

before(async () => {
  state.browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const pages = state.browser.contexts().flatMap((context) => context.pages());
  const candidates = pages.filter(
    (item) => item.url().startsWith("app://-/") && !item.url().includes("avatar-overlay"),
  );
  assert.ok(candidates.length >= 1, "未找到 Codex 页面目标");
  state.page = candidates[0];
});

async function openDetails() {
  await state.page.evaluate(() => {
    const root = document.getElementById("tui-native");
    if (root) root.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
  return state.page.evaluate(() => !!document.getElementById("tui-detail-dialog"));
}

async function readDialog() {
  return state.page.evaluate(() => {
    const dialog = document.getElementById("tui-detail-dialog");
    if (!dialog) return null;
    const firstSection = dialog.querySelector(".tui-dialog-section");
    return {
      open: dialog.getAttribute("data-open") === "true",
      role: dialog.getAttribute("role"),
      titles: [...dialog.querySelectorAll(".tui-dialog-section-title")].map((node) => node.textContent),
      firstSectionLabels: firstSection
        ? [...firstSection.querySelectorAll(".tui-dialog-card-label")].map((node) => node.textContent)
        : [],
    };
  });
}

async function closeIfOpen() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await state.page.evaluate(() => {
      const dialog = document.getElementById("tui-detail-dialog");
      if (!dialog) return;
      if (dialog.getAttribute("data-open") !== "closing") {
        document.body.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }),
        );
      }
    });
    try {
      await state.page.waitForFunction(() => !document.getElementById("tui-detail-dialog"), null, { timeout: 500 });
      return true;
    } catch {
      await state.page.evaluate(() => {
        const close = document.querySelector("#tui-detail-dialog .tui-dialog-close");
        if (close) close.click();
      });
    }
  }
  return false;
}

test("实机：统计条唯一且位于上下文用量圆圈左侧", async (t) => {
  const info = await state.page.evaluate(() => {
    const root = document.getElementById("tui-native");
    const ring = document.querySelector(
      '[aria-label*="上下文用量"], [aria-label*="上下文窗口"], [aria-label*="Context usage" i], [aria-label*="Context window" i]',
    );
    const rootRect = root ? root.getBoundingClientRect() : null;
    const ringRect = ring ? ring.getBoundingClientRect() : null;
    return {
      panelCount: document.querySelectorAll("#tui-native").length,
      styleCount: document.querySelectorAll("#tui-native-style").length,
      panelRect: rootRect ? { left: rootRect.left, right: rootRect.right } : null,
      ringRect: ringRect ? { left: ringRect.left, right: ringRect.right } : null,
      labels: root ? [...root.querySelectorAll(".tui-native-label")].map((node) => node.textContent) : [],
    };
  });
  t.diagnostic(JSON.stringify(info));
  assert.equal(info.panelCount, 1, "统计条数量应为 1");
  assert.equal(info.styleCount, 1, "样式表数量应为 1（多于 1 说明重复注入）");
  assert.ok(info.panelRect && info.ringRect, "统计条或上下文圆圈缺失");
  assert.ok(info.panelRect.right <= info.ringRect.left + 4, "统计条未位于上下文圆圈左侧");
  assert.ok(info.labels.includes("当前提问"), "紧凑条缺少“当前提问”标签");
});

test("实机：负载协议与隐私白名单", async (t) => {
  const payload = await state.page.evaluate(() => window.__tuiForCodex || null);
  assert.ok(payload, "页面没有收到负载");
  const keys = Object.keys(payload);
  const unknown = keys.filter((key) => !PAYLOAD_WHITELIST.has(key));
  const raw = JSON.stringify(payload);
  const leakPatterns = [
    ["rollout 文件名", /rollout-/i],
    ["jsonl 路径", /\.jsonl/i],
    ["本机绝对路径", /[A-Za-z]:\\\\Users/i],
    ["file 字段", /"file"\s*:/i],
    ["threadId 字段", /"threadId"\s*:/i],
    ["responseId 字段", /"responseId"\s*:/i],
    ["turnId 字段", /"turnId"\s*:/i],
  ];
  const leaks = leakPatterns.filter(([, pattern]) => pattern.test(raw)).map(([name]) => name);
  const transientKeys = await state.page.evaluate(() => ({
    bootstrap: "__tuiForCodexAuthBootstrap" in window,
    legacyKey: "__tuiForCodexAuthKey" in window,
  }));
  t.diagnostic(
    JSON.stringify({
      schemaVersion: payload.schemaVersion,
      authVersion: payload.auth && payload.auth.v,
      keyCount: keys.length,
      unknown,
      leaks,
      transientKeys,
    }),
  );
  assert.equal(payload.schemaVersion, 5, "schema 版本应为 5");
  assert.equal(payload.authRequired, true, "v4 负载必须声明 authRequired=true");
  assert.equal(payload.auth && payload.auth.v, 2, "认证版本应为 2");
  assert.ok(payload.auth && /^[0-9a-f]{32}$/.test(payload.auth.keyId), "keyId 格式无效");
  assert.ok(payload.auth && /^[0-9a-f]{32}$/.test(payload.auth.nonce), "nonce 格式无效");
  assert.ok(payload.auth && /^[0-9a-f]{64}$/.test(payload.auth.mac), "v4 负载必须携带 HMAC 签名");
  assert.deepEqual(transientKeys, { bootstrap: false, legacyKey: false }, "临时密钥入口没有清理");
  assert.deepEqual(unknown, [], "负载出现白名单外的字段");
  assert.deepEqual(leaks, [], "负载疑似包含路径或线程 ID");
});

test("实机：刷新心跳（运行中 1 秒 / 空闲 5 秒，两档都算通过）", async (t) => {
  const first = await state.page.evaluate(() => window.__tuiForCodex && window.__tuiForCodex.updatedAt);
  await new Promise((resolve) => setTimeout(resolve, 6500));
  const second = await state.page.evaluate(() => window.__tuiForCodex && window.__tuiForCodex.updatedAt);
  const deltaMs = Date.parse(second) - Date.parse(first);
  t.diagnostic(JSON.stringify({ first, second, deltaMs }));
  // 两档心跳：任务运行中 1000ms（轮询粒度为 1 秒，实测 ≈1.0-1.1 秒）、空闲 5000ms。
  // 这里同时接受两档；越界才失败（既捕捉「心跳停了」，也捕捉「频率失控」）。
  assert.ok(deltaMs >= 800 && deltaMs <= 9000, "刷新间隔不在 0.8~9 秒范围: " + deltaMs);
});

test("实机：详情分区顺序与统计信息请求数量", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  const detail = await readDialog();
  t.diagnostic(JSON.stringify(detail));
  assert.ok(detail && detail.open, "详情未处于打开状态");
  assert.equal(detail.role, "dialog", "详情缺少 dialog 语义");
  assert.deepEqual(
    detail.titles.slice(0, 4),
    ["统计信息", "当前提问统计", "上下文使用", "监控操作"],
    "分区顺序不符合预期",
  );
  assert.ok(detail.firstSectionLabels.includes("请求"), "统计信息缺少请求数量");
  const monitorSection = await state.page.evaluate(() => {
    const dialog = document.getElementById("tui-detail-dialog");
    if (!dialog) return null;
    const section = [...dialog.querySelectorAll(".tui-dialog-section")].find(
      (item) => item.querySelector(".tui-dialog-section-title")?.textContent === "监控操作",
    );
    return section
      ? {
          labels: [...section.querySelectorAll(".tui-dialog-card-label")].map((node) => node.textContent),
          hasStatusGrid: !!section.querySelector(".tui-dialog-grid"),
          hasStartButton: section.querySelector(".tui-dialog-action")?.textContent === "启动/检查监控",
          hasSecurityPanel: !!section.querySelector(".tui-dialog-security"),
        }
      : null;
  });
  t.diagnostic("监控操作分区: " + JSON.stringify(monitorSection));
  assert.ok(monitorSection, "缺少“监控操作”分区");
  assert.deepEqual(monitorSection.labels, [], "运行状态字段仍在展示");
  assert.equal(monitorSection.hasStatusGrid, false, "运行状态网格仍存在");
  assert.equal(monitorSection.hasStartButton, true, "手动启动入口被误删");
  assert.equal(monitorSection.hasSecurityPanel, true, "CDP 安全告警入口被误删");
  assert.equal(await closeIfOpen(), true, "清理：详情未能关闭");
});

test("实机：上下文使用显示实际上限而非“未知”", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  const context = await state.page.evaluate(() => {
    const dialog = document.getElementById("tui-detail-dialog");
    if (!dialog) return null;
    const sections = [...dialog.querySelectorAll(".tui-dialog-section")];
    const target = sections.find(
      (section) => section.querySelector(".tui-dialog-section-title")?.textContent === "上下文使用",
    );
    if (!target) return { found: false };
    const muted = target.querySelector(".tui-dialog-muted");
    const used = target.querySelector(".tui-dialog-context-value");
    return {
      found: true,
      limitText: muted ? muted.textContent : null,
      usedText: used ? used.textContent : null,
      fillWidth: target.querySelector(".tui-dialog-context-fill")?.style?.width || null,
      payloadWindow: window.__tuiForCodex ? window.__tuiForCodex.modelContextWindow : null,
    };
  });
  t.diagnostic(JSON.stringify(context));
  assert.ok(context && context.found, "未找到“上下文使用”分区");
  assert.ok(!/未知/.test(context.limitText || ""), "上限仍显示为未知: " + context.limitText);
  assert.ok(/上限/.test(context.limitText || ""), "未渲染上限文案: " + context.limitText);
  assert.ok(Number.isFinite(context.payloadWindow), "负载未携带上下文上限");
  assert.equal(await closeIfOpen(), true, "清理：详情未能关闭");
});

test("实机：上下文分类使用完整整数并明确标注估算", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  const context = await state.page.evaluate(() => {
    const dialog = document.getElementById("tui-detail-dialog");
    const section = dialog
      ? [...dialog.querySelectorAll(".tui-dialog-section")].find(
          (item) => item.querySelector(".tui-dialog-section-title")?.textContent === "上下文使用",
        )
      : null;
    return {
      value: section?.querySelector(".tui-dialog-context-value")?.textContent || "",
      limit: section?.querySelector(".tui-dialog-muted")?.textContent || "",
      legend: [...(section?.querySelectorAll(".tui-context-legend-row") || [])].map((row) => row.textContent.trim()),
      note: [...(section?.querySelectorAll(".tui-dialog-muted") || [])].map((node) => node.textContent),
      hasBreakdown: !!(window.__tuiForCodex && window.__tuiForCodex.contextBreakdown),
    };
  });
  t.diagnostic(JSON.stringify(context));
  assert.ok(context.legend.length === 4, "上下文分类图例不完整");
  assert.ok(!/\d(?:\.\d+)?[KMB]\b/i.test(context.value + " " + context.limit), "上下文仍使用 K/M/B 缩写");
  if (context.hasBreakdown) {
    assert.ok(
      context.note.some((text) => /本地估算|分类覆盖不足/.test(text)),
      "估算分类缺少明确说明",
    );
  }
  assert.equal(await closeIfOpen(), true, "清理：详情未能关闭");
});

test("实机：统计范围按需加载并保留上次选择", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  const initial = await state.page.evaluate(() => {
    const select = document.querySelector("#tui-detail-dialog .tui-range-select");
    return {
      value: select?.value || "",
      options: [...(select?.options || [])].map((option) => [option.value, option.textContent]),
    };
  });
  assert.deepEqual(initial.options, [
    ["today", "今日"],
    ["3d", "近 3 天"],
    ["7d", "近 7 日"],
    ["30d", "近 30 日"],
    ["all", "全部"],
  ]);
  await state.page.evaluate(() => {
    const select = document.querySelector("#tui-detail-dialog .tui-range-select");
    select.value = "7d";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await state.page.waitForFunction(
    () => window.__tuiForCodex && window.__tuiForCodex.rangeSummary && window.__tuiForCodex.rangeSummary.range === "7d",
    null,
    { timeout: 6000 },
  );
  const loaded = await state.page.evaluate(() => {
    const dialog = document.getElementById("tui-detail-dialog");
    const section = dialog?.querySelector(".tui-dialog-section");
    return {
      selected: dialog?.querySelector(".tui-range-select")?.value,
      status: dialog?.querySelector(".tui-dialog-range-status")?.textContent,
      values: [...(section?.querySelectorAll(".tui-dialog-card-value") || [])].map((node) => node.textContent),
      ranged: window.__tuiForCodex.rangeSummary.range,
    };
  });
  t.diagnostic(JSON.stringify({ initial, loaded }));
  assert.equal(loaded.selected, "7d");
  assert.equal(loaded.ranged, "7d");
  assert.ok(/近 7 日/.test(loaded.status || ""), "范围状态未显示近 7 日");
  assert.ok(
    loaded.values.some((value) => value !== "--"),
    "范围统计仍为空",
  );
  assert.equal(await closeIfOpen(), true, "清理：详情未能关闭");
  await state.page.waitForFunction(
    () => !window.__tuiForCodex?.rangeSummary && !document.documentElement.getAttribute("data-tui-range"),
    null,
    { timeout: 5000 },
  );

  assert.ok(await openDetails(), "无法重新打开详情弹层");
  const restored = await state.page.evaluate(
    () => document.querySelector("#tui-detail-dialog .tui-range-select")?.value || "",
  );
  assert.equal(restored, "7d", "关闭后没有恢复上次范围选择");
  await state.page.evaluate((previous) => {
    const select = document.querySelector("#tui-detail-dialog .tui-range-select");
    select.value = previous;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, initial.value || "all");
  assert.equal(await closeIfOpen(), true, "清理：详情未能关闭");
});

test("实机：会话与当前轮时间带展示总用时、工具用时和 TTFT", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  const timing = await state.page.evaluate(() => {
    const dialog = document.getElementById("tui-detail-dialog");
    const sections = dialog ? [...dialog.querySelectorAll(".tui-dialog-section")] : [];
    return sections.slice(0, 2).map((section) => ({
      title: section.querySelector(".tui-dialog-section-title")?.textContent,
      labels: [...section.querySelectorAll(".tui-dialog-timing-label")].map((node) => node.textContent.trim()),
      values: [...section.querySelectorAll(".tui-dialog-timing-value")].map((node) => node.textContent),
      hidden: section.querySelector(".tui-dialog-timing")?.hidden,
    }));
  });
  t.diagnostic(JSON.stringify(timing));
  assert.equal(timing.length, 2);
  assert.deepEqual(timing[0].labels, ["累计处理用时", "工具累计", "平均 TTFT"]);
  assert.deepEqual(timing[1].labels, ["本轮总用时", "工具用时", "TTFT"]);
  assert.ok(timing.every((row) => row.values.length === 3));
  assert.equal(await closeIfOpen(), true, "清理：详情未能关闭");
});

test("实机：高性能设备启用强磨砂档位", async (t) => {
  const eligible = await state.page.evaluate(() => {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
    const cores = Number(navigator.hardwareConcurrency || 0);
    const memory = Number(navigator.deviceMemory || 0);
    return !reduce && (cores >= 8 || memory >= 8) && !(cores > 0 && cores < 8) && !(memory > 0 && memory < 8);
  });
  if (!eligible) {
    t.skip("当前环境不满足强磨砂硬件条件");
    return;
  }
  assert.ok(await openDetails(), "无法打开详情弹层");
  const result = await state.page.evaluate(() => {
    const dialog = document.getElementById("tui-detail-dialog");
    return {
      strong: dialog?.classList.contains("tui-glass-strong") || false,
      backdrop: dialog ? getComputedStyle(dialog).backdropFilter : "",
    };
  });
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.strong, true, "高性能设备未启用强磨砂");
  assert.ok(/blur/.test(result.backdrop || ""), "强磨砂未应用 backdrop-filter");
  assert.equal(await closeIfOpen(), true, "清理：详情未能关闭");
});

test("实机：点击弹层外部关闭（主要关闭方式）", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  const closingState = await state.page.evaluate(() => {
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }),
    );
    const root = document.getElementById("tui-native");
    return {
      open: document.getElementById("tui-detail-dialog")?.getAttribute("data-open") || null,
      ariaExpanded: root ? root.getAttribute("aria-expanded") : null,
    };
  });
  t.diagnostic("外部点击(PointerEvent)关闭动画: " + JSON.stringify(closingState));
  assert.equal(closingState.open, "closing", "外部点击未进入关闭动画");
  assert.equal(closingState.ariaExpanded, "false", "关闭开始后 aria-expanded 未复位");
  await state.page.waitForFunction(() => !document.getElementById("tui-detail-dialog"), null, { timeout: 700 });
  assert.equal(await state.page.evaluate(() => !!document.getElementById("tui-detail-dialog")), false);
});

test("实机：仅 mousedown 也能关闭（PointerEvent 兜底）", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  await state.page.evaluate(() => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
  await state.page.waitForFunction(() => !document.getElementById("tui-detail-dialog"), null, { timeout: 700 });
  t.diagnostic("仅 mousedown 关闭: true");
});

test("实机：点击弹层内部不会关闭", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  const stillOpen = await state.page.evaluate(() => {
    const dialog = document.getElementById("tui-detail-dialog");
    const body = dialog ? dialog.querySelector(".tui-dialog-body") : null;
    if (body) {
      body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
    }
    return !!document.getElementById("tui-detail-dialog");
  });
  t.diagnostic("内部点击后是否仍打开: " + stillOpen);
  assert.equal(stillOpen, true, "点击弹层内部误关闭了详情");
  assert.equal(await closeIfOpen(), true, "清理：详情未能关闭");
});

test("实机：右上角关闭按钮可用", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  const closingState = await state.page.evaluate(() => {
    const close = document.querySelector("#tui-detail-dialog .tui-dialog-close");
    if (!close) return "missing";
    close.click();
    return document.getElementById("tui-detail-dialog")?.getAttribute("data-open") || null;
  });
  t.diagnostic("关闭按钮关闭动画: " + closingState);
  assert.equal(closingState, "closing", "关闭按钮未触发关闭动画");
  await state.page.waitForFunction(() => !document.getElementById("tui-detail-dialog"), null, { timeout: 700 });
});

test("实机：Esc 不再关闭弹层（插件不注册键盘监听）", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  const stillOpen = await state.page.evaluate(() => {
    const target = document.activeElement || document.body || document.documentElement;
    const init = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return !!document.getElementById("tui-detail-dialog");
  });
  t.diagnostic("DOM Esc 后弹层仍打开: " + stillOpen);
  await closeIfOpen();
  assert.equal(stillOpen, true, "按当前设计 Esc 不应关闭弹层（键盘监听已按用户要求移除）");
});

test("实机：无 auth 的伪造 schema v5 负载会被拒绝", async (t) => {
  const result = await state.page.evaluate(async () => {
    const backup = window.__tuiForCodex;
    const forged = JSON.parse(JSON.stringify(backup));
    delete forged.auth;
    forged.sessionTotal = 123456789;
    document.documentElement.setAttribute("data-tui-security", "0");
    window.__tuiForCodex = forged;
    window.dispatchEvent(new Event("tokens-ui-for-codex"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const root = document.getElementById("tui-native");
    const ariaLabel = root ? root.getAttribute("aria-label") : null;
    const security = Number(document.documentElement.getAttribute("data-tui-security") || "0");
    window.__tuiForCodex = backup;
    window.dispatchEvent(new Event("tokens-ui-for-codex"));
    return { ariaLabel, security };
  });
  t.diagnostic("无签名负载处理: " + JSON.stringify(result));
  assert.ok(result.security >= 1, "无签名负载没有进入安全拒绝计数");
  assert.ok(!String(result.ariaLabel || "").includes("123,456,789"), "伪造总量进入了 UI");
});

test("实机：auth v2 会拒绝正文、seq、旧时间戳篡改，并接受新 keyId", async (t) => {
  const result = await state.page.evaluate(async () => {
    const original = JSON.parse(JSON.stringify(window.__tuiForCodex));
    const nativeDispatch = window.dispatchEvent.bind(window);
    let testDispatchAllowed = false;
    window.dispatchEvent = (event) => {
      if (event && event.type === "tokens-ui-for-codex" && !testDispatchAllowed) return true;
      return nativeDispatch(event);
    };
    const authDomain = "tokens-ui-for-codex/auth-v2";
    const toHex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const canonicalJson = (value) => {
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
    };
    const makeKey = async () => {
      const rawKey = crypto.getRandomValues(new Uint8Array(32));
      const keyHex = toHex(rawKey);
      const keyId = toHex(crypto.getRandomValues(new Uint8Array(16)));
      const key = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return { key, keyHex, keyId };
    };
    const body = JSON.parse(JSON.stringify(original));
    delete body.auth;
    body.updatedAt = new Date().toISOString();
    const sign = async (key, authCore) => {
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(authDomain + "\n" + canonicalJson(body) + "\n" + canonicalJson(authCore)),
      );
      return { ...body, auth: { ...authCore, mac: toHex(new Uint8Array(signature)) } };
    };
    const dispatch = async (payload, bootstrap) => {
      if (bootstrap) window.__tuiForCodexAuthBootstrap = bootstrap;
      window.__tuiForCodex = payload;
      testDispatchAllowed = true;
      nativeDispatch(new Event("tokens-ui-for-codex"));
      testDispatchAllowed = false;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        security: Number(document.documentElement.getAttribute("data-tui-security") || "0"),
        bootstrapPresent: "__tuiForCodexAuthBootstrap" in window,
      };
    };
    try {
      const first = await makeKey();
      document.documentElement.setAttribute("data-tui-security", "0");
      const auth1 = {
        v: 2,
        keyId: first.keyId,
        ts: Date.now(),
        nonce: toHex(crypto.getRandomValues(new Uint8Array(16))),
        seq: 1,
      };
      const valid = await sign(first.key, auth1);
      const accepted = await dispatch(valid, { key: first.keyHex, keyId: first.keyId });

      const auth2 = {
        ...auth1,
        ts: Date.now(),
        nonce: toHex(crypto.getRandomValues(new Uint8Array(16))),
        seq: 2,
      };
      const bodyTampered = await sign(first.key, auth2);
      bodyTampered.sessionTotal = Number(bodyTampered.sessionTotal || 0) + 1;
      const bodyRejected = await dispatch(bodyTampered);

      const auth3 = {
        ...auth1,
        ts: Date.now(),
        nonce: toHex(crypto.getRandomValues(new Uint8Array(16))),
        seq: 3,
      };
      const seqTampered = await sign(first.key, auth3);
      seqTampered.auth.seq = 4;
      const seqRejected = await dispatch(seqTampered);

      const replayed = await dispatch(valid);

      const auth5 = {
        ...auth1,
        ts: Date.now() - 31000,
        nonce: toHex(crypto.getRandomValues(new Uint8Array(16))),
        seq: 5,
      };
      const stalePayload = await sign(first.key, auth5);
      const staleRejected = await dispatch(stalePayload);

      const second = await makeKey();
      const auth6 = {
        v: 2,
        keyId: second.keyId,
        ts: Date.now(),
        nonce: toHex(crypto.getRandomValues(new Uint8Array(16))),
        seq: 1,
      };
      const rotatedPayload = await sign(second.key, auth6);
      const rotated = await dispatch(rotatedPayload, { key: second.keyHex, keyId: second.keyId });
      return { accepted, bodyRejected, seqRejected, replayed, staleRejected, rotated };
    } finally {
      window.dispatchEvent = nativeDispatch;
      window.__tuiForCodex = original;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 5500));
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.accepted.bootstrapPresent, false, "有效事件结束后仍残留临时密钥");
  assert.ok(result.bodyRejected.security > result.accepted.security, "正文篡改未被拒绝");
  assert.ok(result.seqRejected.security > result.bodyRejected.security, "seq 篡改未被拒绝");
  assert.ok(result.replayed.security > result.seqRejected.security, "重放未被拒绝");
  assert.ok(result.staleRejected.security > result.replayed.security, "过期时间戳未被拒绝");
  assert.equal(result.rotated.security, 0, "新 keyId 没有重置认证状态");
  assert.equal(result.rotated.bootstrapPresent, false, "keyId 轮换后临时密钥仍残留");
});

test("实机：紧凑条优先使用稳健速度，样本不足显示 --T/s", async (t) => {
  const result = await state.page.evaluate(async () => {
    const original = JSON.parse(JSON.stringify(window.__tuiForCodex));
    const nativeDispatch = window.dispatchEvent.bind(window);
    let testDispatchAllowed = false;
    window.dispatchEvent = (event) => {
      if (event && event.type === "tokens-ui-for-codex" && !testDispatchAllowed) return true;
      return nativeDispatch(event);
    };
    let sequence = 0;
    const authDomain = "tokens-ui-for-codex/auth-v2";
    const toHex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const canonicalJson = (value) => {
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
    };
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const keyHex = toHex(rawKey);
    const keyId = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const key = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const push = async ({ compactTps, sampleCount, confidence, genEstimateTps }) => {
      const body = JSON.parse(JSON.stringify(original));
      delete body.auth;
      body.compactTps = compactTps;
      body.compactSpeedSampleCount = sampleCount;
      body.compactSpeedConfidence = confidence;
      body.compactSpeedWindow = 5;
      body.genEstimateTps = genEstimateTps;
      body.updatedAt = new Date().toISOString();
      const ts = Date.now();
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
      sequence += 1;
      const authCore = { v: 2, keyId, ts, nonce, seq: sequence };
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(authDomain + "\n" + canonicalJson(body) + "\n" + canonicalJson(authCore)),
      );
      const mac = toHex(new Uint8Array(signature));
      const payload = { ...body, auth: { ...authCore, mac } };
      window.__tuiForCodexAuthBootstrap = { key: keyHex, keyId };
      window.__tuiForCodex = payload;
      testDispatchAllowed = true;
      nativeDispatch(new Event("tokens-ui-for-codex"));
      testDispatchAllowed = false;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return document.querySelector("#tui-native .tui-native-tps .tui-native-value")?.textContent;
    };
    try {
      const robust = await push({
        compactTps: 123.4,
        sampleCount: 4,
        confidence: "medium",
        genEstimateTps: 9999,
      });
      const insufficient = await push({
        compactTps: null,
        sampleCount: 1,
        confidence: "low",
        genEstimateTps: 9999,
      });
      await push({
        compactTps: original.compactTps,
        sampleCount: original.compactSpeedSampleCount || 0,
        confidence: original.compactSpeedConfidence || "low",
        genEstimateTps: original.genEstimateTps,
      });
      return { robust, insufficient };
    } finally {
      window.dispatchEvent = nativeDispatch;
      window.__tuiForCodex = original;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 5500));
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.robust, "≈123T/s", "稳健速度未被紧凑条采用");
  assert.equal(result.insufficient, "--T/s", "样本不足时回退到了单条尖峰");
});

test("实机：Playwright 真实鼠标点击能否打开详情", { skip: realInputSkip }, async (t) => {
  let worked = false;
  try {
    await state.page.click(PANEL_SELECTOR, { timeout: 3000 });
    worked = await state.page.evaluate(() => !!document.getElementById("tui-detail-dialog"));
  } catch (error) {
    t.diagnostic("真实鼠标点击异常: " + error.message);
  }
  t.diagnostic("真实鼠标点击是否生效: " + worked);
  if (!worked) {
    t.diagnostic("结论：CDP 注入的鼠标事件未送达 Codex 渲染页面。");
  }
  await closeIfOpen();
});

test("实机：Playwright 真实键盘 Esc 不会关闭弹层", { skip: realInputSkip }, async (t) => {
  await openDetails();
  let stillOpen = false;
  try {
    await state.page.keyboard.press("Escape");
    await new Promise((resolve) => setTimeout(resolve, 200));
    stillOpen = await state.page.evaluate(() => !!document.getElementById("tui-detail-dialog"));
  } catch (error) {
    t.diagnostic("真实键盘事件异常: " + error.message);
  }
  t.diagnostic("真实键盘 Esc 后弹层仍打开: " + stillOpen);
  await closeIfOpen();
  assert.equal(stillOpen, true, "按当前设计 Esc 不应关闭弹层（键盘监听已按用户要求移除）");
});

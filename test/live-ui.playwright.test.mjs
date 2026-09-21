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
const CDP_ENDPOINT = process.env.TUI_CDP_URL || "http://127.0.0.1:9229";
const PANEL_SELECTOR = "#tui-native";
const ALLOW_REAL_INPUT = process.env.TUI_ALLOW_REAL_INPUT === "1";
const realInputSkip = ALLOW_REAL_INPUT
  ? false
  : "默认跳过真实输入注入：Escape 会被 Codex 当作“停止回答”，需要显式设置 TUI_ALLOW_REAL_INPUT=1";

const PAYLOAD_WHITELIST = new Set([
  "protocolName",
  "schemaVersion",
  "capabilities",
  "modelContextWindow",
  "requestCount",
  "sessionTotal",
  "sessionInput",
  "sessionCached",
  "sessionOutput",
  "sessionCacheHitRate",
  "sessionTps",
  "contextUsed",
  "turnTotal",
  "turnInput",
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
  const closed = await state.page.evaluate(() => {
    if (!document.getElementById("tui-detail-dialog")) return true;
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }),
    );
    if (document.getElementById("tui-detail-dialog")) {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    }
    if (document.getElementById("tui-detail-dialog")) {
      const close = document.querySelector("#tui-detail-dialog .tui-dialog-close");
      if (close) close.click();
    }
    return !document.getElementById("tui-detail-dialog");
  });
  return closed;
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
  t.diagnostic(JSON.stringify({ schemaVersion: payload.schemaVersion, keyCount: keys.length, unknown, leaks }));
  assert.equal(payload.schemaVersion, 2, "schema 版本应为 2");
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

test("实机：详情分区顺序与会话累计请求数量", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  const detail = await readDialog();
  t.diagnostic(JSON.stringify(detail));
  assert.ok(detail && detail.open, "详情未处于打开状态");
  assert.equal(detail.role, "dialog", "详情缺少 dialog 语义");
  assert.deepEqual(
    detail.titles.slice(0, 4),
    ["会话累计", "当前提问统计", "上下文使用", "运行状态"],
    "分区顺序不符合预期",
  );
  assert.ok(detail.firstSectionLabels.includes("请求"), "会话累计缺少请求数量");
  const healthLabels = await state.page.evaluate(() => {
    const dialog = document.getElementById("tui-detail-dialog");
    if (!dialog) return [];
    const section = [...dialog.querySelectorAll(".tui-dialog-section")].find(
      (item) => item.querySelector(".tui-dialog-section-title")?.textContent === "运行状态",
    );
    return section ? [...section.querySelectorAll(".tui-dialog-card-label")].map((node) => node.textContent) : [];
  });
  t.diagnostic("运行状态字段: " + JSON.stringify(healthLabels));
  assert.ok(healthLabels.includes("模型切换"), "运行状态缺少“模型切换”");
  assert.ok(healthLabels.includes("累计重置"), "运行状态缺少“累计重置”");
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

test("实机：点击弹层外部关闭（主要关闭方式）", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  const closed = await state.page.evaluate(() => {
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }),
    );
    const root = document.getElementById("tui-native");
    return {
      dialogExists: !!document.getElementById("tui-detail-dialog"),
      ariaExpanded: root ? root.getAttribute("aria-expanded") : null,
    };
  });
  t.diagnostic("外部点击(PointerEvent)关闭: " + JSON.stringify(closed));
  assert.equal(closed.dialogExists, false, "外部点击未关闭详情");
  assert.equal(closed.ariaExpanded, "false", "关闭后 aria-expanded 未复位");
});

test("实机：仅 mousedown 也能关闭（PointerEvent 兜底）", async (t) => {
  assert.ok(await openDetails(), "无法打开详情弹层");
  const closed = await state.page.evaluate(() => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    return !document.getElementById("tui-detail-dialog");
  });
  t.diagnostic("仅 mousedown 关闭: " + closed);
  assert.equal(closed, true, "缺少 PointerEvent 时无法点击外部关闭");
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
  const closed = await state.page.evaluate(() => {
    const close = document.querySelector("#tui-detail-dialog .tui-dialog-close");
    if (!close) return "missing";
    close.click();
    return !document.getElementById("tui-detail-dialog");
  });
  t.diagnostic("关闭按钮结果: " + closed);
  assert.equal(closed, true, "关闭按钮不可用");
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

test("实机：无效负载会被页面拒绝", async (t) => {
  // 注意：这里必须是同步的、绝不 await 任何计时器。
  // 面板的数据事件处理是同步的（dispatchEvent 返回时 DOM 已更新），一旦让出事件循环，
  // 监控的心跳推送（运行中 1 秒/次）就可能把注入的非法负载覆盖掉，
  // 断言随之变成"看运气"（实测间歇失败复现率约 17%，见 CHANGELOG 2026-09-21）。
  const result = await state.page.evaluate(() => {
    const backup = window.__tuiForCodex;
    window.__tuiForCodex = { protocolName: "tokens-ui-for-codex", schemaVersion: 2, bogus: true };
    window.dispatchEvent(new Event("tokens-ui-for-codex"));
    const root = document.getElementById("tui-native");
    const panelError = root ? root.classList.contains("tui-native-error") : null;
    const ariaLabel = root ? root.getAttribute("aria-label") : null;
    window.__tuiForCodex = backup;
    window.dispatchEvent(new Event("tokens-ui-for-codex"));
    return { panelError, ariaLabel };
  });
  t.diagnostic("无效负载处理: " + JSON.stringify(result));
  assert.equal(result.panelError, true, "无效负载未被标记为错误状态");
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

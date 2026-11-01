// 只读检查：Codex 页面里插件与监控数据的当前状态。不注入任何输入。
// 用法：node scripts/check-page-state.mjs [--port auto|<n>]

import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { portArgOf, resolveCdpPort } from "./cdp-port.mjs";

const require = createRequire(import.meta.url);
const globalNodeModules = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules");

function loadPlaywright() {
  for (const candidate of ["playwright", "playwright-core", path.join(globalNodeModules, "playwright")]) {
    try {
      return require(candidate);
    } catch {}
  }
  throw new Error("无法加载 Playwright");
}

const { chromium } = loadPlaywright();
const port = await resolveCdpPort(portArgOf(process.argv.slice(2)));
const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
const pages = browser.contexts().flatMap((context) => context.pages());
const rows = [];
for (const page of pages) {
  const url = page.url();
  if (!url.startsWith("app://-/")) {
    rows.push({ url, skipped: true });
    continue;
  }
  const info = await page
    .evaluate(() => ({
      // 唯一性检查：统计条 / 样式表 / 弹层各只允许一份（出现两份说明注入了两个面板脚本）。
      panelCount: document.querySelectorAll("#tui-native").length,
      styleCount: document.querySelectorAll("#tui-native-style").length,
      dialogCount: document.querySelectorAll("#tui-detail-dialog").length,
      protocolRegistered: !!window.__tuiForCodexProtocol,
      payloadSchema: window.__tuiForCodex ? window.__tuiForCodex.schemaVersion : null,
      payloadAuthVersion: window.__tuiForCodex && window.__tuiForCodex.auth ? window.__tuiForCodex.auth.v : null,
      payloadKeyId: window.__tuiForCodex && window.__tuiForCodex.auth ? window.__tuiForCodex.auth.keyId : null,
      transientAuthBootstrap: "__tuiForCodexAuthBootstrap" in window,
      legacyAuthKey: "__tuiForCodexAuthKey" in window,
      securityRejected: Number(document.documentElement.getAttribute("data-tui-security") || "0"),
      securityReason: document.documentElement.getAttribute("data-tui-security-reason"),
      payloadUpdatedAt: window.__tuiForCodex ? window.__tuiForCodex.updatedAt : null,
      payloadStatus: window.__tuiForCodex && window.__tuiForCodex.health ? window.__tuiForCodex.health.status : null,
      payloadRequestCount: window.__tuiForCodex ? window.__tuiForCodex.requestCount : null,
      payloadContextUsed: window.__tuiForCodex ? window.__tuiForCodex.contextUsed : null,
      payloadContextBreakdown: window.__tuiForCodex ? window.__tuiForCodex.contextBreakdown : null,
      payloadSessionWallMs: window.__tuiForCodex ? window.__tuiForCodex.sessionWallMs : null,
      payloadSessionToolWallMs: window.__tuiForCodex ? window.__tuiForCodex.sessionToolWallMs : null,
      payloadSessionTtftAvgMs: window.__tuiForCodex ? window.__tuiForCodex.sessionTtftAvgMs : null,
      payloadRangeSummary: window.__tuiForCodex ? window.__tuiForCodex.rangeSummary : null,
      payloadTurnWallMs: window.__tuiForCodex ? window.__tuiForCodex.turnWallMs : null,
      payloadTurnToolWallMs: window.__tuiForCodex ? window.__tuiForCodex.turnToolWallMs : null,
      payloadTurnTtftMs: window.__tuiForCodex ? window.__tuiForCodex.turnTtftMs : null,
      payloadModelContextWindow: window.__tuiForCodex ? window.__tuiForCodex.modelContextWindow : null,
      payloadCompactTps: window.__tuiForCodex ? window.__tuiForCodex.compactTps : null,
      payloadCompactSpeedSampleCount: window.__tuiForCodex ? window.__tuiForCodex.compactSpeedSampleCount : null,
      payloadCompactSpeedConfidence: window.__tuiForCodex ? window.__tuiForCodex.compactSpeedConfidence : null,
      payloadTurnWallTps: window.__tuiForCodex ? window.__tuiForCodex.turnWallTps : null,
      dialogOpen: !!document.getElementById("tui-detail-dialog"),
      healthDotTitle:
        document.querySelector("#tui-detail-dialog .tui-dialog-health-dot")?.getAttribute("title") || null,
      bodyReady: !!document.body,
      styleInstalled: !!document.getElementById("tui-native-style"),
      installedFlag: window.__tuiForCodexNativeUiInstalled === true,
      ringCount: document.querySelectorAll(
        '[aria-label*="上下文用量"], [aria-label*="上下文窗口"], [aria-label*="Context usage" i], [aria-label*="Context window" i]',
      ).length,
      ringLabel: (() => {
        const ring = document.querySelector(
          '[aria-label*="上下文用量"], [aria-label*="上下文窗口"], [aria-label*="Context usage" i], [aria-label*="Context window" i]',
        );
        return ring ? ring.getAttribute("aria-label") : null;
      })(),
      mainPresent: !!document.querySelector("main"),
      composerPresent: !!document.querySelector('[data-thread-find-composer="true"], [data-codex-composer="true"]'),
      conversationPresent: !!document.querySelector('main [data-thread-find-target="conversation"]'),
      sidebarThreadPresent: !!document.querySelector(
        '[data-app-action-sidebar-thread-id], [aria-current="page"][data-app-action-sidebar-thread-id]',
      ),
      labelsMatchingContext: [...document.querySelectorAll("[aria-label]")]
        .map((node) => node.getAttribute("aria-label"))
        .filter((label) => typeof label === "string" && /用量|usage|context|token/i.test(label))
        .slice(0, 30),
      composerSelectors: {
        threadFindComposer: !!document.querySelector('[data-thread-find-composer="true"]'),
        codexComposer: !!document.querySelector('[data-codex-composer="true"]'),
        svgInComposerArea: document.querySelectorAll("main svg").length,
      },
    }))
    .catch((error) => ({ error: error.message }));
  rows.push({ url, ...info });
}
console.log(JSON.stringify(rows, null, 2));
process.exit(0);

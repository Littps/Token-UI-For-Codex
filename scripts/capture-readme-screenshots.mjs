import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  AUTH_VERSION,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_NAME,
  PROTOCOL_SCHEMA_VERSION,
  authSigningText,
} from "../protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelSource = fs.readFileSync(path.join(root, "tokens-ui-for-codex-panel.js"), "utf8");

function makePayload() {
  const now = new Date().toISOString();
  return {
    protocolName: PROTOCOL_NAME,
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    authRequired: true,
    capabilities: PROTOCOL_CAPABILITIES.slice(),
    modelContextWindow: 996147,
    requestCount: 328,
    currentTurnRequestCount: 12,
    sessionTotal: 1284600000,
    sessionInput: 1269000000,
    sessionCached: 1258000000,
    sessionOutput: 15600000,
    sessionCacheHitRate: 0.9913,
    sessionTps: 152,
    sessionWallMs: 7420000,
    sessionToolWallMs: 1380000,
    sessionToolCallCount: 418,
    sessionTtftAvgMs: 1860,
    sessionTimingSampleCount: 27,
    turnTotal: 9860000,
    turnInput: 9780000,
    turnCached: 9600000,
    turnOutput: 80000,
    turnCacheHitRate: 0.9816,
    turnWallMs: 138000,
    turnToolWallMs: 27400,
    turnToolCallCount: 9,
    turnTtftMs: 1420,
    turnTimingCoverage: 0.96,
    turnTimingQuality: "high",
    turnEffectiveTps: 164.8,
    lastRequestTps: 172,
    turnTps: 165,
    turnWallTps: 101.2,
    genEstimateTps: 176,
    compactTps: 159.4,
    compactSpeedSampleCount: 5,
    compactSpeedConfidence: "high",
    compactSpeedWindow: 5,
    effectiveTps: 168.2,
    effectiveSampleCount: 20,
    effectiveWindow: 25,
    speedTimingConfidence: "high",
    contextUsed: 428000,
    contextBreakdown: {
      estimated: true,
      estimatorVersion: 1,
      systemPromptTokens: 54000,
      toolDefinitionTokens: 212000,
      conversationTokens: 118000,
      otherTokens: 44000,
    },
    rangeSummary: {
      range: "all",
      available: true,
      retentionDays: 60,
      cutoffAt: null,
      generatedAt: now,
      availableFrom: "2026-09-22T08:51:58.370Z",
      availableThrough: now,
      sessionCount: 8,
      turnCount: 164,
      requestCount: 21840,
      input: 3402000000,
      cached: 3305000000,
      output: 109400000,
      total: 3511400000,
      cacheComplete: true,
      wallMs: 121280000,
      toolWallMs: 26400000,
      toolCallCount: 5240,
      ttftSampleCount: 151,
      ttftAvgMs: 2140,
      effectiveMs: 94880000,
      effectiveTps: 152.9,
      timingSampleCount: 159,
    },
    currentTurnIndex: 42,
    turnTotalCount: 42,
    turns: Array.from({ length: 10 }, (_, index) => ({
      index: 33 + index,
      startLabel: `${String(10 + Math.floor(index / 3)).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}`,
      requests: 4 + (index % 7),
      input: 65000 + index * 14750,
      cached: 61000 + index * 13900,
      uncached: 4000 + index * 850,
      output: 1900 + index * 310,
      total: 66900 + index * 15060,
      wallMs: 21000 + index * 1250,
      toolWallMs: 2800 + index * 160,
      toolCallCount: 1 + (index % 5),
      ttftMs: 1600 + index * 21,
      timingCoverage: 0.94,
      timingQuality: "high",
    })),
    turnsTruncated: true,
    turnsLimit: 500,
    requestDetails: Array.from({ length: 10 }, (_, index) => ({
      index: 319 + index,
      time: `19:${String(12 + index).padStart(2, "0")}`,
      input: 842000 + index * 11300,
      cached: 831000 + index * 11100,
      uncached: 11000 + index * 200,
      output: 1400 + index * 260,
      total: 843400 + index * 11560,
    })),
    requestDetailsTruncated: true,
    requestDetailTotal: 328,
    requestsLimit: 500,
    modelSwitchCount: 3,
    cumulativeResetCount: 0,
    sessionChanged: false,
    snapshot: false,
    updatedAt: now,
    health: {
      status: "healthy",
      recoveryState: "idle",
      platform: "windows",
      platformSupported: true,
      nodeSupported: true,
      cdpReachable: true,
      pageAttached: true,
      targetMode: "auto",
      targetSelection: "single",
      targetCount: 1,
      dataFresh: true,
      lastSuccessAt: now,
      lastErrorCode: null,
      lastErrorAt: null,
      monitorRunning: true,
      autostartInstalled: true,
      installationState: "ready",
    },
  };
}

function sign(body, { key, keyId, seq }) {
  const authCore = {
    v: AUTH_VERSION,
    keyId,
    ts: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex"),
    seq,
  };
  const mac = crypto.createHmac("sha256", key).update(authSigningText(body, authCore)).digest("hex");
  return { ...body, auth: { ...authCore, mac } };
}

const html = `<!doctype html>
<html data-theme="light">
<head>
<meta charset="utf-8">
<style>
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; height: 100%; font-family: "Segoe UI", sans-serif; }
body { background: #eef2f3; color: #202426; overflow: hidden; }
.app { display: flex; width: 100vw; height: 100vh; }
.sidebar { width: 250px; padding: 24px 18px; background: #e4eaec; border-right: 1px solid #ced7da; }
.logo { width: 34px; height: 34px; border-radius: 10px; background: #202426; margin-bottom: 30px; }
.side-row { height: 14px; border-radius: 7px; background: #c7d1d4; margin: 15px 0; opacity: .75; }
.main { position: relative; flex: 1; padding: 38px 70px 120px; min-width: 0; }
.top { width: 76%; height: 30px; border-radius: 9px; background: #d8e0e2; margin-bottom: 34px; }
.line { height: 13px; border-radius: 7px; background: #d5dee0; margin: 19px 0; opacity: .72; }
.line.short { width: 44%; } .line.medium { width: 68%; }
.card { position: absolute; left: 70px; right: 70px; bottom: 46px; height: 86px; border-radius: 24px; background: #fff; border: 1px solid #d4dcdf; box-shadow: 0 15px 38px rgba(40, 50, 55, .10); }
.tools { position: absolute; left: 24px; bottom: 22px; color: #667176; font-size: 22px; }
.composer-right { position: absolute; right: 28px; bottom: 20px; display: flex; align-items: center; gap: 8px; }
.ring { width: 18px; height: 18px; }
.ring svg { width: 18px; height: 18px; transform: rotate(-90deg); }
.ring circle { fill: none; stroke: #aeb9bd; stroke-width: 3; }
.ring .progress { stroke: #5b7cfa; stroke-dasharray: 76 100; }
.send { width: 38px; height: 38px; border-radius: 50%; background: #747e82; color: white; display: grid; place-items: center; font-size: 22px; }
html[data-theme="dark"] body { background: #17191c; color: #f5f7f8; }
html[data-theme="dark"] .sidebar { background: #202327; border-color: #31363b; }
html[data-theme="dark"] .logo,html[data-theme="dark"] .side-row,html[data-theme="dark"] .top,html[data-theme="dark"] .line { background: #30353a; }
html[data-theme="dark"] .card { background: #24282c; border-color: #3a4046; box-shadow: 0 18px 48px rgba(0,0,0,.42); }
html[data-theme="dark"] .ring circle { stroke: #626b72; }
html[data-theme="dark"] .send { background: #d7dde0; color: #202428; }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar" aria-hidden="true"><div class="logo"></div><div class="side-row"></div><div class="side-row"></div><div class="side-row"></div><div class="side-row"></div></aside>
  <main>
    <div class="top" aria-hidden="true"></div>
    <div class="line medium" aria-hidden="true"></div><div class="line" aria-hidden="true"></div>
    <div class="line short" aria-hidden="true"></div><div class="line medium" aria-hidden="true"></div>
    <div class="line" aria-hidden="true"></div><div class="line short" aria-hidden="true"></div>
    <section class="card" aria-label="示例输入框">
      <div class="tools" aria-hidden="true">＋</div>
      <div class="composer-right">
        <div class="ring" aria-label="上下文用量：43%"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="15"></circle><circle class="progress" cx="20" cy="20" r="15"></circle></svg></div>
        <div class="send" aria-hidden="true">↑</div>
      </div>
    </section>
  </main>
</div>
</body></html>`;

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, channel: "msedge" });

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 1.5,
    colorScheme: "light",
  });
  const page = await context.newPage();
  const address = server.address();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });
  await page.addScriptTag({ content: panelSource });
  await page.waitForSelector("#tui-native", { timeout: 3000 });

  const key = Buffer.alloc(32, 0x71);
  const keyId = "71".repeat(16);
  const payload = sign(makePayload(), { key, keyId, seq: 1 });
  await page.evaluate(
    async ({ payload, keyHex, keyId }) => {
      window.__tuiForCodexAuthBootstrap = { key: keyHex, keyId };
      window.__tuiForCodex = payload;
      window.dispatchEvent(new Event("tokens-ui-for-codex"));
      await new Promise((resolve) => setTimeout(resolve, 220));
      document.getElementById("tui-native")?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 180));
    },
    { payload, keyHex: key.toString("hex"), keyId },
  );
  await page.screenshot({ path: path.join(root, "readme01.png") });

  await page.evaluate(async () => {
    const body = document.querySelector("#tui-detail-dialog .tui-dialog-body");
    const sections = [...document.querySelectorAll("#tui-detail-dialog .tui-dialog-section")];
    if (body && sections[2]) {
      body.scrollTop += sections[2].getBoundingClientRect().top - body.getBoundingClientRect().top;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  await page.locator("#tui-detail-dialog").screenshot({ path: path.join(root, "readme03.png") });

  await page.evaluate(async () => {
    document.querySelector("#tui-detail-dialog .tui-dialog-close")?.click();
    document.documentElement.setAttribute("data-theme", "dark");
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
  const darkPayload = sign({ ...makePayload(), updatedAt: new Date().toISOString() }, { key, keyId, seq: 2 });
  await page.evaluate(
    async ({ payload }) => {
      window.__tuiForCodex = payload;
      window.dispatchEvent(new Event("tokens-ui-for-codex"));
      await new Promise((resolve) => setTimeout(resolve, 220));
      document.getElementById("tui-native")?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 180));
      const body = document.querySelector("#tui-detail-dialog .tui-dialog-body");
      const sections = [...document.querySelectorAll("#tui-detail-dialog .tui-dialog-section")];
      if (body && sections[4]) {
        body.scrollTop += sections[4].getBoundingClientRect().top - body.getBoundingClientRect().top;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    },
    { payload: darkPayload },
  );
  await page.screenshot({ path: path.join(root, "readme02.png") });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(
  JSON.stringify(
    {
      readme01: path.join(root, "readme01.png"),
      readme02: path.join(root, "readme02.png"),
      readme03: path.join(root, "readme03.png"),
    },
    null,
    2,
  ),
);

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  AUTH_VERSION,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_NAME,
  PROTOCOL_SCHEMA_VERSION,
  authSigningText,
  validatePayload,
} from "../protocol.mjs";

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

function launchOptions() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  return executablePath ? { headless: true, executablePath } : { headless: true, channel: "msedge" };
}

const { chromium } = loadPlaywright();
const panelSource = fs.readFileSync(new URL("../tokens-ui-for-codex-panel.js", import.meta.url), "utf8");
let browser;
let page;
let server;

function basePayload() {
  return {
    protocolName: PROTOCOL_NAME,
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    authRequired: true,
    capabilities: PROTOCOL_CAPABILITIES.slice(),
    modelContextWindow: 1000000,
    requestCount: 3,
    currentTurnRequestCount: 2,
    sessionTotal: 300,
    sessionInput: 240,
    sessionCached: 120,
    sessionOutput: 60,
    sessionCacheHitRate: 0.5,
    sessionTps: 40,
    genEstimateTps: 50,
    compactTps: 45,
    compactSpeedSampleCount: 4,
    compactSpeedConfidence: "medium",
    compactSpeedWindow: 5,
    turnWallTps: 30,
    effectiveTps: 35,
    turnEffectiveTps: 32,
    effectiveSampleCount: 3,
    effectiveWindow: 25,
    speedTimingConfidence: "medium",
    contextUsed: 200000,
    turnTotal: 200,
    turnInput: 150,
    turnCached: 75,
    turnOutput: 50,
    turnCacheHitRate: 0.5,
    lastRequestTps: 10,
    turnTps: 20,
    turnsLimit: 500,
    requestsLimit: 500,
    sessionChanged: false,
    snapshot: false,
    currentTurnIndex: 2,
    turns: [
      {
        index: 1,
        startLabel: "10:00",
        requests: 1,
        input: 90,
        cached: 45,
        uncached: 45,
        output: 10,
        total: 100,
      },
      {
        index: 2,
        startLabel: "10:01",
        requests: 2,
        input: 150,
        cached: 75,
        uncached: 75,
        output: 50,
        total: 200,
      },
    ],
    turnsTruncated: false,
    turnTotalCount: 2,
    requestDetails: [
      {
        index: 2,
        time: "10:02",
        input: 80,
        cached: 40,
        uncached: 40,
        output: 20,
        total: 100,
      },
      {
        index: 3,
        time: "10:03",
        input: 70,
        cached: 35,
        uncached: 35,
        output: 30,
        total: 100,
      },
    ],
    requestDetailsTruncated: false,
    requestDetailTotal: 2,
    modelSwitchCount: 1,
    cumulativeResetCount: 0,
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
      lastSuccessAt: new Date().toISOString(),
      lastErrorCode: null,
      lastErrorAt: null,
      monitorRunning: true,
      autostartInstalled: true,
      installationState: "ready",
    },
    updatedAt: new Date().toISOString(),
  };
}

function rangeSummaryFixture(range, total) {
  const now = new Date().toISOString();
  return {
    range,
    available: true,
    retentionDays: 60,
    cutoffAt: null,
    generatedAt: now,
    availableFrom: "2026-10-01T00:00:00.000Z",
    availableThrough: now,
    sessionCount: 2,
    turnCount: 4,
    requestCount: 6,
    input: total - 100,
    cached: total - 200,
    output: 100,
    total,
    cacheComplete: true,
    wallMs: 10000,
    toolWallMs: 2000,
    toolCallCount: 3,
    ttftAvgMs: 500,
    effectiveMs: 8000,
    effectiveTps: 12.5,
    timingSampleCount: 4,
    ttftSampleCount: 4,
  };
}

function makeSigner(seed) {
  const key = Buffer.alloc(32, seed);
  const keyId = seed.toString(16).padStart(2, "0").repeat(16);
  return { key, keyId };
}

function sign(body, signer, { ts = Date.now(), seq = 1, nonce = crypto.randomBytes(16).toString("hex") } = {}) {
  const authCore = { v: AUTH_VERSION, keyId: signer.keyId, ts, nonce, seq };
  const mac = crypto.createHmac("sha256", signer.key).update(authSigningText(body, authCore)).digest("hex");
  return { ...body, auth: { ...authCore, mac } };
}

before(async () => {
  browser = await chromium.launch(launchOptions());
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const html = `
    <!doctype html>
    <html data-theme="light">
      <head>
        <style>
          body { margin: 0; font-family: sans-serif; }
          #host { display: flex; align-items: center; gap: 8px; width: 640px; height: 60px; padding: 10px; }
          #ring { width: 40px; height: 40px; }
          #ring svg { width: 40px; height: 40px; }
        </style>
      </head>
      <body>
        <main>
          <div id="host">
            <button type="button">tools</button>
            <div id="ring-wrap">
              <div id="ring" aria-label="上下文用量 20%"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="16"></circle></svg></div>
            </div>
          </div>
        </main>
      </body>
    </html>
  `;
  server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });
  await page.addScriptTag({ content: panelSource });
  await page.waitForSelector("#tui-native", { timeout: 3000 });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("本地隔离页：auth v2 接受有效负载并拒绝正文/seq/重放/过期篡改", async () => {
  const signer = makeSigner(0x11);
  const body = basePayload();
  const valid = sign(body, signer, { seq: 1 });
  assert.equal(validatePayload(valid, { allowLegacy: false, requireAuth: true }).ok, true);

  const accepted = await page.evaluate(
    async ({ validPayload, keyHex, keyId }) => {
      window.__tuiForCodexAuthBootstrap = { key: keyHex, keyId };
      window.__tuiForCodex = validPayload;
      window.dispatchEvent(new Event("tokens-ui-for-codex"));
      await new Promise((resolve) => setTimeout(resolve, 180));
      const root = document.getElementById("tui-native");
      return {
        security: Number(document.documentElement.getAttribute("data-tui-security") || "0"),
        reason: document.documentElement.getAttribute("data-tui-security-reason"),
        bootstrapPresent: "__tuiForCodexAuthBootstrap" in window,
        legacyKeyPresent: "__tuiForCodexAuthKey" in window,
        ariaLabel: root && root.getAttribute("aria-label"),
      };
    },
    { validPayload: valid, keyHex: signer.key.toString("hex"), keyId: signer.keyId },
  );
  assert.equal(accepted.security, 0, "有效负载被拒绝：" + accepted.reason);
  assert.equal(accepted.bootstrapPresent, false);
  assert.equal(accepted.legacyKeyPresent, false);
  assert.match(String(accepted.ariaLabel), /会话 300/);

  const nonceReplay = sign(body, signer, { seq: 2, nonce: valid.auth.nonce });
  const bodyTampered = sign(body, signer, { seq: 2 });
  bodyTampered.sessionTotal = 999999;
  const seqTampered = sign(body, signer, { seq: 3 });
  seqTampered.auth.seq = 4;
  const stale = sign(body, signer, { seq: 5, ts: Date.now() - 31000 });

  const rejected = await page.evaluate(
    async ({ nonceReplayPayload, bodyTamperedPayload, seqTamperedPayload, stalePayload, replayedPayload }) => {
      const wait = () => new Promise((resolve) => setTimeout(resolve, 160));
      const dispatch = async (payload) => {
        window.__tuiForCodex = payload;
        window.dispatchEvent(new Event("tokens-ui-for-codex"));
        await wait();
        return Number(document.documentElement.getAttribute("data-tui-security") || "0");
      };
      const nonceSecurity = await dispatch(nonceReplayPayload);
      const bodySecurity = await dispatch(bodyTamperedPayload);
      const seqSecurity = await dispatch(seqTamperedPayload);
      const replaySecurity = await dispatch(replayedPayload);
      const staleSecurity = await dispatch(stalePayload);
      const ariaLabel = document.getElementById("tui-native")?.getAttribute("aria-label");
      return { nonceSecurity, bodySecurity, seqSecurity, replaySecurity, staleSecurity, ariaLabel };
    },
    {
      nonceReplayPayload: nonceReplay,
      bodyTamperedPayload: bodyTampered,
      seqTamperedPayload: seqTampered,
      replayedPayload: valid,
      stalePayload: stale,
    },
  );
  assert.ok(rejected.nonceSecurity >= 1, "更高 seq 复用旧 nonce 未被拒绝");
  assert.ok(rejected.bodySecurity > rejected.nonceSecurity);
  assert.ok(rejected.seqSecurity > rejected.bodySecurity);
  assert.ok(rejected.replaySecurity > rejected.seqSecurity);
  assert.ok(rejected.staleSecurity > rejected.replaySecurity);
  assert.doesNotMatch(String(rejected.ariaLabel), /999,999/);
});

test("本地隔离页：新 keyId 可轮换并重置安全计数", async () => {
  const signer = makeSigner(0x22);
  const body = basePayload();
  body.sessionTotal = 777;
  body.updatedAt = new Date().toISOString();
  const payload = sign(body, signer, { seq: 1 });
  const result = await page.evaluate(
    async ({ nextPayload, keyHex, keyId }) => {
      document.documentElement.setAttribute("data-tui-security", "9");
      window.__tuiForCodexAuthBootstrap = { key: keyHex, keyId };
      window.__tuiForCodex = nextPayload;
      window.dispatchEvent(new Event("tokens-ui-for-codex"));
      await new Promise((resolve) => setTimeout(resolve, 180));
      return {
        security: Number(document.documentElement.getAttribute("data-tui-security") || "0"),
        bootstrapPresent: "__tuiForCodexAuthBootstrap" in window,
        ariaLabel: document.getElementById("tui-native")?.getAttribute("aria-label"),
      };
    },
    { nextPayload: payload, keyHex: signer.key.toString("hex"), keyId: signer.keyId },
  );
  assert.equal(result.security, 0);
  assert.equal(result.bootstrapPresent, false);
  assert.match(String(result.ariaLabel), /会话 777/);
});

test("本地隔离页：签名有效但跨字段语义不一致时拒绝渲染", async () => {
  const signer = makeSigner(0x33);
  const body = basePayload();
  body.sessionInput = 1;
  body.sessionCached = 2;
  body.updatedAt = new Date().toISOString();
  const payload = sign(body, signer, { seq: 1 });
  const result = await page.evaluate(
    async ({ nextPayload, keyHex, keyId }) => {
      window.__tuiForCodexAuthBootstrap = { key: keyHex, keyId };
      window.__tuiForCodex = nextPayload;
      window.dispatchEvent(new Event("tokens-ui-for-codex"));
      await new Promise((resolve) => setTimeout(resolve, 180));
      return {
        security: Number(document.documentElement.getAttribute("data-tui-security") || "0"),
        ariaLabel: document.getElementById("tui-native")?.getAttribute("aria-label"),
      };
    },
    { nextPayload: payload, keyHex: signer.key.toString("hex"), keyId: signer.keyId },
  );
  assert.equal(result.security, 0, "认证层不应把语义错误误报为签名失败");
  assert.match(String(result.ariaLabel), /协议不匹配/);
  assert.doesNotMatch(String(result.ariaLabel), /会话 300/);
});

test("本地隔离页：详情重新打开时立即使用范围与明细缓存，并等待新负载替换", async () => {
  await page.evaluate(() => {
    localStorage.removeItem("tokens-ui-for-codex.range-cache.v1");
    localStorage.setItem("tokens-ui-for-codex.stats-range", "all");
  });
  const signer = makeSigner(0x44);
  const expandedBody = basePayload();
  expandedBody.rangeSummary = rangeSummaryFixture("all", 123456);
  expandedBody.updatedAt = new Date().toISOString();
  const expanded = sign(expandedBody, signer, { seq: 1 });
  const fresh = await page.evaluate(
    async ({ payload, keyHex, keyId }) => {
      window.__tuiForCodexAuthBootstrap = { key: keyHex, keyId };
      window.__tuiForCodex = payload;
      window.dispatchEvent(new Event("tokens-ui-for-codex"));
      await new Promise((resolve) => setTimeout(resolve, 180));
      document.getElementById("tui-native")?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const dialog = document.getElementById("tui-detail-dialog");
      return {
        status: dialog?.querySelector(".tui-dialog-range-status")?.textContent,
        total: dialog?.querySelector(".tui-dialog-card-value")?.textContent,
      };
    },
    { payload: expanded, keyHex: signer.key.toString("hex"), keyId: signer.keyId },
  );
  assert.match(String(fresh.status), /全部 · 2 个会话/);
  assert.equal(fresh.total, "123,456 tokens");

  await page.evaluate(async () => {
    document.querySelector("#tui-detail-dialog .tui-dialog-close")?.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
  });

  const compactBody = basePayload();
  compactBody.requestDetails = [];
  compactBody.requestDetailsTruncated = true;
  compactBody.requestDetailTotal = 2;
  compactBody.rangeSummary = null;
  compactBody.updatedAt = new Date().toISOString();
  const compact = sign(compactBody, signer, { seq: 2 });
  const cached = await page.evaluate(async (payload) => {
    window.__tuiForCodex = payload;
    window.dispatchEvent(new Event("tokens-ui-for-codex"));
    await new Promise((resolve) => setTimeout(resolve, 180));
    document.getElementById("tui-native")?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const dialog = document.getElementById("tui-detail-dialog");
    const stored = JSON.parse(localStorage.getItem("tokens-ui-for-codex.range-cache.v1") || "null");
    return {
      subtitle: dialog?.querySelector(".tui-dialog-subtitle")?.textContent,
      status: dialog?.querySelector(".tui-dialog-range-status")?.textContent,
      total: dialog?.querySelector(".tui-dialog-card-value")?.textContent,
      cachedTotal: stored?.ranges?.all?.summary?.total,
    };
  }, compact);
  assert.match(String(cached.subtitle), /详情缓存.*刷新中/);
  assert.match(String(cached.status), /缓存于.*刷新中.*全部/);
  assert.equal(cached.total, "123,456 tokens");
  assert.equal(cached.cachedTotal, 123456);
  await page.evaluate(async () => {
    document.querySelector("#tui-detail-dialog .tui-dialog-close")?.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
  });

  await page.reload({ waitUntil: "load" });
  await page.addScriptTag({ content: panelSource });
  await page.waitForSelector("#tui-native", { timeout: 3000 });
  const reloadSigner = makeSigner(0x45);
  const reloadBody = basePayload();
  reloadBody.sessionTotal = 555;
  reloadBody.requestDetails = [];
  reloadBody.requestDetailsTruncated = true;
  reloadBody.requestDetailTotal = 2;
  reloadBody.rangeSummary = null;
  reloadBody.updatedAt = new Date().toISOString();
  const reloadPayload = sign(reloadBody, reloadSigner, { seq: 1 });
  const restored = await page.evaluate(
    async ({ payload, keyHex, keyId }) => {
      window.__tuiForCodexAuthBootstrap = { key: keyHex, keyId };
      window.__tuiForCodex = payload;
      window.dispatchEvent(new Event("tokens-ui-for-codex"));
      await new Promise((resolve) => setTimeout(resolve, 180));
      document.getElementById("tui-native")?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const dialog = document.getElementById("tui-detail-dialog");
      return {
        status: dialog?.querySelector(".tui-dialog-range-status")?.textContent,
        total: dialog?.querySelector(".tui-dialog-card-value")?.textContent,
      };
    },
    { payload: reloadPayload, keyHex: reloadSigner.key.toString("hex"), keyId: reloadSigner.keyId },
  );
  assert.match(String(restored.status), /缓存于.*刷新中.*全部/);
  assert.equal(restored.total, "123,456 tokens");
  await page.evaluate(async () => {
    document.querySelector("#tui-detail-dialog .tui-dialog-close")?.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
});

test("本地隔离页：健康灯悬浮提示包含错误码、原因、恢复状态和未知错误分类", async () => {
  const signer = makeSigner(0x55);
  const body = basePayload();
  body.health.status = "waiting-for-page";
  body.health.recoveryState = "retrying";
  body.health.pageAttached = false;
  body.health.dataFresh = false;
  body.health.lastErrorCode = "CDP_PAGE_NOT_READY";
  body.health.lastErrorAt = new Date().toISOString();
  body.updatedAt = new Date().toISOString();
  const known = sign(body, signer, { seq: 1 });
  const knownResult = await page.evaluate(
    async ({ payload, keyHex, keyId }) => {
      window.__tuiForCodexAuthBootstrap = { key: keyHex, keyId };
      window.__tuiForCodex = payload;
      window.dispatchEvent(new Event("tokens-ui-for-codex"));
      await new Promise((resolve) => setTimeout(resolve, 180));
      document.getElementById("tui-native")?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const dot = document.querySelector("#tui-detail-dialog .tui-dialog-health-dot");
      return {
        title: dot?.getAttribute("title"),
        aria: dot?.getAttribute("aria-label"),
        role: dot?.getAttribute("role"),
        tabIndex: dot?.getAttribute("tabindex"),
      };
    },
    { payload: known, keyHex: signer.key.toString("hex"), keyId: signer.keyId },
  );
  assert.match(String(knownResult.title), /CDP_PAGE_NOT_READY/);
  assert.match(String(knownResult.title), /Codex\+\+ Token UI 尚未加载/);
  assert.match(String(knownResult.title), /恢复状态：重试中/);
  assert.equal(knownResult.role, "status");
  assert.equal(knownResult.tabIndex, "0");
  assert.match(String(knownResult.aria), /CDP_PAGE_NOT_READY/);

  const unknownBody = basePayload();
  unknownBody.health.status = "failed";
  unknownBody.health.recoveryState = "failed";
  unknownBody.health.dataFresh = false;
  unknownBody.health.lastErrorCode = "OTHER_UNCLASSIFIED";
  unknownBody.health.lastErrorAt = new Date().toISOString();
  unknownBody.updatedAt = new Date().toISOString();
  const unknown = sign(unknownBody, signer, { seq: 2 });
  const unknownTitle = await page.evaluate(async (payload) => {
    window.__tuiForCodex = payload;
    window.dispatchEvent(new Event("tokens-ui-for-codex"));
    await new Promise((resolve) => setTimeout(resolve, 180));
    return document.querySelector("#tui-detail-dialog .tui-dialog-health-dot")?.getAttribute("title");
  }, unknown);
  assert.match(String(unknownTitle), /其他（OTHER_UNCLASSIFIED）/);
  assert.match(String(unknownTitle), /检查本地 watch 日志/);
  await page.evaluate(() => document.querySelector("#tui-detail-dialog .tui-dialog-close")?.click());
});

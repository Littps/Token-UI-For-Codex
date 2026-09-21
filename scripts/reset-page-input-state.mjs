// 清理诊断脚本在 Codex 页面上留下的残留状态。
// 只做读取与复位：移除探针元素、删除探针全局变量、关闭焦点模拟。
// 不注入任何键鼠事件。用法：node scripts/reset-page-input-state.mjs

import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

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
const browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
const pages = browser.contexts().flatMap((context) => context.pages());
const page = pages.find((item) => item.url().startsWith("app://-/") && !item.url().includes("avatar-overlay"));
if (!page) throw new Error("未找到 Codex 页面目标");

const client = await page.context().newCDPSession(page);
const snapshot = () =>
  page.evaluate(() => ({
    probeElementExists: !!document.getElementById("__tui_input_probe"),
    probeGlobalExists: typeof window.__tuiInputProbe === "object" && window.__tuiInputProbe !== null,
    hasFocus: document.hasFocus(),
    visibilityState: document.visibilityState,
    activeElement: document.activeElement
      ? document.activeElement.id || document.activeElement.tagName
      : null,
  }));

const before = await snapshot();
const notes = [];

try {
  await client.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  notes.push("已关闭焦点模拟（Emulation.setFocusEmulationEnabled=false）");
} catch (error) {
  notes.push("关闭焦点模拟失败: " + error.message);
}

await page.evaluate(() => {
  document.getElementById("__tui_input_probe")?.remove();
  try {
    delete window.__tuiInputProbe;
  } catch {}
});

const after = await snapshot();
console.log(JSON.stringify({ before, after, notes }, null, 2));
process.exit(0);

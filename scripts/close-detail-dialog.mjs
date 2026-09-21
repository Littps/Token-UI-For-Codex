// 用页面内 DOM 事件关闭详情弹层（等价于点击外部），不注入真实键鼠事件。
// 用法：node scripts/close-detail-dialog.mjs

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

const result = await page.evaluate(() => {
  const before = !!document.getElementById("tui-detail-dialog");
  if (!before) return { before, after: false, path: "无需处理" };
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
  return {
    before,
    after: !!document.getElementById("tui-detail-dialog"),
    path: "pointerdown → mousedown → ×",
  };
});

console.log(JSON.stringify(result, null, 2));
process.exit(0);

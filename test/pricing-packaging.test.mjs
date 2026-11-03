import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const requiredRuntimeFiles = ["openrouter-pricing.mjs", "service-tier-pricing.mjs", "model-usage.mjs"];

test("价格模块随安装、源码包、同步检查和隔离 watchdog fixture 一起交付", () => {
  for (const file of [
    "install.ps1",
    "scripts/build-source-package.ps1",
    "scripts/verify-sync.mjs",
    "scripts/verify-watchdog.ps1",
  ]) {
    const source = fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
    for (const runtimeFile of requiredRuntimeFiles) {
      assert.ok(source.includes('"' + runtimeFile + '"'), file + " must include " + runtimeFile);
    }
  }
});

test("安装与审计工具使用当前 v5 schema，PowerShell 文件保留 UTF-8 BOM", () => {
  for (const file of [
    "install.ps1",
    "scripts/build-source-package.ps1",
    "scripts/verify-sync.mjs",
    "scripts/verify-audit-findings.mjs",
  ]) {
    const source = fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
    assert.ok(source.includes("payload-v5.schema.json"), file + " must check current schema");
  }
  for (const file of ["install.ps1", "scripts/build-source-package.ps1", "scripts/verify-watchdog.ps1"]) {
    const bytes = fs.readFileSync(new URL("../" + file, import.meta.url));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], file + " must preserve BOM");
  }
});

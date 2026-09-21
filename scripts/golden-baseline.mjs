#!/usr/bin/env node
// 行为基线（golden baseline）
//
// 目的：把「重构前」的对外行为固化成可复现的标准答案，让重构后的差异变成可判定的，
//       而不是靠人肉印象。
//
// 覆盖范围：命令行入口（参数解析 → 会话文件解析 → 统计 → 打印）的完整 stdout。
//           这条链路正好覆盖本次重构要替换的「文件发现 / 会话 ID / 格式化 / CLI 打印」几块。
//
// 不覆盖：需要活体 Codex 页面的部分（线程 ID 检测、CDP 推送），那些由 npm run verify:live 兜。
//
// 隐私：基线文件**只记录哈希与字节数**，不写入任何会话内容、文件路径或线程 ID；
//       语料用「文件名哈希」做键，既稳定又不泄露本机信息。
//
// 用法：
//   node scripts/golden-baseline.mjs --write    生成基线（重构前运行一次）
//   node scripts/golden-baseline.mjs --check    校验（重构后运行；任何差异都会以非 0 退出）
//   node scripts/golden-baseline.mjs --check --refresh-corpus   重新冻结语料后再校验
//
// 语料快照只冻结一次并重复复用：会话文件（尤其是正在进行的那个）会持续增长，
// 每次重新复制会让哈希变化，从而把「会话变长」误判成「实现改坏」。

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const statsScript = path.join(root, "token-stats.mjs");
const baselineFile = path.join(root, "test", "golden", "cli-baseline.json");
const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
const CLI_TIMEOUT_MS = 120000;
const DETAIL_SAMPLE_COUNT = 3;

// 语料快照：当前会话文件正在被实时写入，直接指向真实目录会让哈希每次都变。
// 这里先把语料复制成一份冻结快照，再用 CODEX_HOME 指向它跑命令行，
// 这样基线比对的是「实现差异」，而不是「会话又长了多少」。
//
// 注意：快照目录必须是**固定路径**。命令行输出里会打印会话文件路径，
// 如果快照目录带随机后缀（比如进程号），每次运行的路径都不同，哈希就永远对不上。
const snapshotRoot = path.join(os.tmpdir(), "tui-golden-corpus");
const snapshotSessionsDir = path.join(snapshotRoot, "sessions");
const snapshotStateDir = path.join(snapshotRoot, "local");

function countSnapshots(dir) {
  let count = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^rollout-.*\.jsonl$/i.test(entry.name)) count += 1;
    }
  };
  walk(dir);
  return count;
}

function freezeCorpus() {
  const force = process.argv.includes("--refresh-corpus");
  if (!force) {
    const existing = countSnapshots(snapshotSessionsDir);
    if (existing > 0) return { copied: 0, reused: existing };
  }
  fs.rmSync(snapshotRoot, { recursive: true, force: true });
  let copied = 0;
  const copyTree = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        copyTree(full);
      } else if (/^rollout-.*\.jsonl$/i.test(entry.name)) {
        const relative = path.relative(sessionsDir, full);
        const target = path.join(snapshotSessionsDir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(full, target);
        copied += 1;
      }
    }
  };
  copyTree(sessionsDir);
  fs.mkdirSync(snapshotStateDir, { recursive: true });
  return { copied, reused: 0 };
}

// 注意：这里刻意不在结束时删除快照——它需要在多次 --check 之间复用，
// 否则每次都会重新复制语料，正在增长的会话又会把哈希变掉。
// 需要更新语料时用 --refresh-corpus；想彻底清理，手动删除临时目录即可。

const mode = process.argv.includes("--write")
  ? "write"
  : process.argv.includes("--check")
    ? "check"
    : null;

if (!mode) {
  console.error("用法: node scripts/golden-baseline.mjs --write | --check");
  process.exit(2);
}

function listSessions() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^rollout-.*\.jsonl$/i.test(entry.name)) out.push(full);
    }
  };
  walk(sessionsDir);
  return out.sort((a, b) => a.localeCompare(b));
}

function threadIdOf(file) {
  const match = path.basename(file).match(
    /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match ? match[1] : null;
}

// 语料键：文件名哈希的前 16 位。稳定、可复现，且不把本机路径或会话 ID 写进仓库。
function fileKeyOf(file) {
  return crypto.createHash("sha256").update(path.basename(file)).digest("hex").slice(0, 16);
}

function runCli(args) {
  const childEnv = { ...process.env };
  delete childEnv.TUI_TOKENS_AS_MODULE;
  childEnv.CODEX_HOME = snapshotRoot;            // 指向冻结语料
  childEnv.LOCALAPPDATA = snapshotStateDir;      // 状态隔离，不碰真实 client-thread-map.json
  childEnv.APPDATA = snapshotStateDir;
  try {
    const stdout = execFileSync(process.execPath, [statsScript, ...args], {
      encoding: "buffer",
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    return { exitCode: 0, stdout };
  } catch (error) {
    return {
      exitCode: typeof error.status === "number" ? error.status : -1,
      stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(error.stdout || ""),
    };
  }
}

function buildCases() {
  const sessions = listSessions();
  const cases = [];
  for (const file of sessions) {
    const id = threadIdOf(file);
    if (!id) continue;
    cases.push({ key: fileKeyOf(file), kind: "thread", args: ["--thread", id] });
  }
  cases.push({ key: "all-threads", kind: "all", args: ["--all"] });
  const smallest = sessions
    .map((file) => ({ file, size: fs.statSync(file).size }))
    .sort((a, b) => a.size - b.size)
    .slice(0, DETAIL_SAMPLE_COUNT);
  for (const item of smallest) {
    const id = threadIdOf(item.file);
    if (!id) continue;
    cases.push({ key: fileKeyOf(item.file) + ":detail", kind: "detail", args: ["--thread", id, "--detail"] });
  }
  return cases;
}

function measure(caseEntry) {
  const { exitCode, stdout } = runCli(caseEntry.args);
  return {
    exitCode,
    bytes: stdout.length,
    sha256: crypto.createHash("sha256").update(stdout).digest("hex"),
  };
}

const corpus = freezeCorpus();
if (corpus.copied === 0 && corpus.reused === 0) {
  console.error("未找到任何会话语料（" + sessionsDir + "），无法建立基线。");
  process.exit(2);
}
if (corpus.reused > 0) {
  console.log("语料快照：复用已冻结的 " + corpus.reused + " 个会话文件（如需更新：--refresh-corpus）。");
} else {
  console.log("语料快照：已冻结 " + corpus.copied + " 个会话文件到临时目录。");
}

const cases = buildCases();
if (cases.length === 0) {
  console.error("未找到任何会话语料（" + sessionsDir + "），无法建立基线。");
  process.exit(2);
}

if (mode === "write") {
  const entries = cases.map((entry) => ({ key: entry.key, kind: entry.kind, ...measure(entry) }));
  const payload = {
    schemaVersion: 1,
    note: "行为基线：只记录命令行输出的哈希与字节数，不含任何会话内容、路径或线程 ID。",
    generatedAt: new Date().toISOString(),
    caseCount: entries.length,
    cases: entries,
  };
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log("已写入基线：" + path.relative(root, baselineFile));
  console.log("用例数：" + entries.length + "（其中 --detail 抽样 " + cases.filter((c) => c.kind === "detail").length + " 个）");
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
const expected = new Map(baseline.cases.map((entry) => [entry.key, entry]));

let compared = 0;
let mismatched = 0;
let missing = 0;
const details = [];

for (const entry of cases) {
  const want = expected.get(entry.key);
  if (!want) {
    missing += 1;
    continue;
  }
  const got = measure(entry);
  compared += 1;
  const same = got.exitCode === want.exitCode && got.bytes === want.bytes && got.sha256 === want.sha256;
  if (!same) {
    mismatched += 1;
    details.push(
      [
        "  用例 " + entry.kind + " (" + entry.key + ") 不一致",
        "    期望  exit=" + want.exitCode + " bytes=" + want.bytes + " sha=" + want.sha256.slice(0, 16),
        "    实际  exit=" + got.exitCode + " bytes=" + got.bytes + " sha=" + got.sha256.slice(0, 16),
      ].join("\n"),
    );
  }
}

const stale = baseline.cases.length - compared;

console.log("行为基线校验");
console.log("  比对用例：" + compared + " / 基线 " + baseline.cases.length);
if (missing > 0) console.log("  语料新增（无基线，跳过）：" + missing);
if (stale > 0) console.log("  基线中存在但本次未出现的用例：" + stale);
console.log("  不一致：" + mismatched);

if (mismatched > 0) {
  console.log("");
  console.log(details.slice(0, 20).join("\n"));
  if (details.length > 20) console.log("  （其余 " + (details.length - 20) + " 条省略）");
  console.log("");
  console.log("结论：行为与基线不一致 —— 重构未通过。");
  process.exit(1);
}

console.log("");
console.log("结论：行为与基线完全一致。");
process.exit(0);

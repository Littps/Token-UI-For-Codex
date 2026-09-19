// 五处副本一致性校验：源码 / 部署 / 插件 cache / Codex++ user_scripts / 打包 zip。
// 任一不一致打印差异并以非 0 退出，供发布流程与 CI 使用。
// 用法：node scripts/verify-sync.mjs [--deploy <目录>] [--zip <包>]

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const argv = process.argv.slice(2);
let deployRoot = process.env.CCM_DEPLOY_ROOT || "";
let zipPath = process.env.CCM_ZIP_PATH || "";
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--deploy" && argv[index + 1]) deployRoot = argv[index + 1];
  else if (argv[index] === "--zip" && argv[index + 1]) zipPath = argv[index + 1];
}

const sourceRoot = path.join(import.meta.dirname, "..");
const pluginCacheRoot = path.join(os.homedir(), ".codex", "plugins", "cache", "tokens-ui-for-codex-local");
const userScriptsRoot = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Codex++", "user_scripts");

function sha256(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function newestPluginDir(root) {
  try {
    // 插件 cache 的真实层级是 <marketplace>/<插件名>/<版本>/（实测），
    // 旧实现只探测了一层，导致"插件cache"长期为 null 而未被察觉。
    // 这里对最多两层做探测，取包含 token-stats.mjs 的最新目录。
    const levelOne = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
    const candidates = [];
    for (const dir of levelOne) {
      if (fs.existsSync(path.join(dir, "token-stats.mjs"))) candidates.push(dir);
      let nested = [];
      try {
        nested = fs.readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(dir, entry.name));
      } catch {}
      for (const sub of nested) {
        if (fs.existsSync(path.join(sub, "token-stats.mjs"))) candidates.push(sub);
      }
    }
    if (!candidates.length) return null;
    candidates.sort();
    return candidates[candidates.length - 1];
  } catch {}
  return null;
}

const pluginCacheDir = newestPluginDir(pluginCacheRoot);
const deployPluginDir = deployRoot ? path.join(deployRoot, "plugins", "tokens-ui-for-codex") : null;

// 注意：launch-silent.vbs 由安装脚本按本机路径生成，各副本内容必然不同，因此不纳入一致性比对。
const CHECKED_FILES = ["token-stats.mjs", "codex-token-spend-panel.js", "protocol.mjs", "find-codex.ps1", "install.ps1", "install-autostart.ps1", "uninstall-autostart.ps1"];

const copies = [
  { name: "源码", root: sourceRoot },
  { name: "部署", root: deployPluginDir },
  { name: "插件cache", root: pluginCacheDir },
];

const results = [];
let mismatches = 0;

for (const file of CHECKED_FILES) {
  const row = { file };
  for (const copy of copies) {
    row[copy.name] = copy.root ? sha256(path.join(copy.root, file)) : null;
  }
  // Codex++ 只保存用户脚本
  row["user_scripts"] = file === "codex-token-spend-panel.js"
    ? sha256(path.join(userScriptsRoot, file))
    : "n/a";
  const values = [row["源码"], row["部署"], row["插件cache"], row["user_scripts"]]
    .filter((value) => value && value !== "n/a");
  row.consistent = values.length > 0 && values.every((value) => value === values[0]);
  if (!row.consistent) mismatches += 1;
  results.push(row);
}

// 打包 zip 内部校验
if (zipPath && fs.existsSync(zipPath)) {
  const buffer = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0 && index > buffer.length - 66000; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd >= 0) {
    const entryCount = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    const zipEntries = new Map();
    for (let index = 0; index < entryCount; index += 1) {
      if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
      const method = buffer.readUInt16LE(offset + 10);
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const localOffset = buffer.readUInt32LE(offset + 42);
      const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      offset += 46 + nameLength + extraLength + commentLength;
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(start, start + compressedSize);
      const content = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
      if (content) zipEntries.set(name, crypto.createHash("sha256").update(content).digest("hex"));
    }
    for (const file of CHECKED_FILES) {
      const key = "Tokens UI For Codex/plugins/tokens-ui-for-codex/" + file.replace(/\\/g, "/");
      const zipHash = zipEntries.get(key) || null;
      const sourceHash = sha256(path.join(sourceRoot, file));
      const ok = zipHash && sourceHash && zipHash === sourceHash;
      if (!ok) mismatches += 1;
      results.push({ file, zip: ok ? zipHash : "MISMATCH", consistent: !!ok });
    }
  }
}

console.log(JSON.stringify({
  sourceRoot,
  deployPluginDir,
  pluginCacheDir,
  userScriptsRoot,
  zipPath: zipPath || null,
  mismatches,
  results,
}, null, 2));

if (mismatches > 0) process.exitCode = 1;

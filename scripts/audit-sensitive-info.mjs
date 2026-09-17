// 只读审计：扫描项目内是否包含密钥、凭据、个人信息与本机绝对路径。
// 只输出命中位置与被掩码后的片段，不输出完整敏感值。
// 用法：node scripts/audit-sensitive-info.mjs [--root <目录>]... [--zip <压缩包>]...

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const argv = process.argv.slice(2);
const roots = [];
const zipPaths = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--root" && argv[index + 1]) roots.push(path.resolve(argv[index + 1]));
  else if (argv[index] === "--zip" && argv[index + 1]) zipPaths.push(path.resolve(argv[index + 1]));
}
if (!roots.length && !zipPaths.length) roots.push(process.cwd());

const SKIP_DIRS = new Set([".git", "node_modules", "backups", ".codex", "dist", "build"]);
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".exe", ".7z", ".zip", ".woff", ".woff2", ".ttf"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// 本机用户名 / 主机名规则按运行环境推导，避免把任何用户名硬编码进仓库。
function localIdentityNames() {
  const names = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim().length >= 3) names.add(value.trim());
  };
  add(process.env.USERNAME);
  add(process.env.USER);
  try {
    add(os.userInfo().username);
  } catch {}
  try {
    add(os.hostname().split(".")[0]);
  } catch {}
  return [...names];
}

function buildLocalIdentityPattern() {
  const names = localIdentityNames();
  if (!names.length) return null;
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("\\b(?:" + escaped.join("|") + ")\\b[A-Za-z0-9._-]*", "g");
}

const RULES = [
  { id: "api-key", severity: "high", label: "API 密钥（sk-/sk-ant-/sk-proj-）", pattern: /\b(?:sk|sk-ant|sk-proj)-[A-Za-z0-9_-]{16,}/g },
  { id: "github-token", severity: "high", label: "GitHub Token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: "aws-key", severity: "high", label: "AWS Access Key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "private-key", severity: "high", label: "私钥文件内容", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: "bearer", severity: "high", label: "Bearer 令牌", pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  { id: "credential-url", severity: "high", label: "带凭据的 URL", pattern: /https?:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/g },
  {
    id: "secret-assignment",
    severity: "high",
    label: "可能的密钥赋值",
    pattern: /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9._\-]{10,}/gi,
  },
  { id: "email", severity: "medium", label: "邮箱地址", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { id: "windows-user-path", severity: "medium", label: "本机绝对路径（含用户名）", pattern: /[A-Za-z]:\\Users\\[^\\\s"')]+/g },
  { id: "local-username", severity: "medium", label: "本机用户名/主机名（按运行环境推导）", pattern: buildLocalIdentityPattern() },
  { id: "cn-mobile", severity: "medium", label: "中国大陆手机号", pattern: /\b1[3-9]\d{9}\b/g },
  { id: "wechat-id", severity: "medium", label: "微信标识", pattern: /\bwxid_[A-Za-z0-9_-]{6,}\b/g },
  { id: "session-log-path", severity: "low", label: "会话日志路径引用（文档说明用）", pattern: /\.codex\\sessions|rollout-\d{4}-\d{2}-\d{2}T/g },
];

function mask(value) {
  const text = String(value);
  if (text.length <= 6) return text[0] + "***";
  return text.slice(0, 4) + "***" + "(" + text.length + " 字符)";
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      out.push(full);
    }
  }
  return out;
}

const findings = new Map();
const scanned = {
  files: 0,
  skippedBinary: 0,
  skippedLarge: 0,
  roots: roots.map((root) => path.basename(root)),
  zips: zipPaths.map((zip) => path.basename(zip)),
  zipEntries: 0,
};

function scanText(label, file, text) {
  const lines = text.split(/\r?\n/);
  for (const rule of RULES) {
    if (!rule.pattern) continue;
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
      const line = lines[lineNumber];
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(line)) !== null) {
        const entry = findings.get(rule.id) || { rule, matches: [] };
        if (entry.matches.length < 25) {
          entry.matches.push({
            file,
            root: label,
            line: lineNumber + 1,
            value: mask(match[0]),
          });
        }
        entry.total = (entry.total || 0) + 1;
        findings.set(rule.id, entry);
        if (match[0].length === 0) break;
      }
    }
  }
}

for (const root of roots) {
  for (const file of walk(root)) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      scanned.skippedLarge += 1;
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) {
      scanned.skippedBinary += 1;
      continue;
    }
    scanned.files += 1;
    scanText(path.basename(root), path.relative(root, file) || path.basename(file), text);
  }
}

// ---- 最小 ZIP 读取器：支持环境自带 zlib，无需第三方依赖 ----
function readZipEntries(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0 && index > buffer.length - 66000; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip（未找到 EOCD）: " + zipPath);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries.map((entry) => {
    const local = entry.localOffset;
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error("zip 局部头损坏: " + entry.name);
    const nameLength = buffer.readUInt16LE(local + 26);
    const extraLength = buffer.readUInt16LE(local + 28);
    const start = local + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + entry.compressedSize);
    let content;
    if (entry.method === 0) content = data;
    else if (entry.method === 8) content = zlib.inflateRawSync(data);
    else return { name: entry.name, text: null };
    return { name: entry.name, text: content.toString("utf8") };
  });
}

for (const zipPath of zipPaths) {
  try {
    for (const entry of readZipEntries(zipPath)) {
      scanned.zipEntries += 1;
      if (entry.text === null) continue;
      if (entry.text.includes("\u0000")) continue;
      scanText(path.basename(zipPath), entry.name, entry.text);
    }
  } catch (error) {
    findings.set("zip-error", {
      rule: { id: "zip-error", severity: "high", label: "压缩包读取失败" },
      total: 1,
      matches: [{ file: path.basename(zipPath), root: path.basename(zipPath), line: 0, value: error.message }],
    });
  }
}

const report = {
  scanned,
  summary: [...findings.values()].map((entry) => ({
    rule: entry.rule.id,
    severity: entry.rule.severity,
    label: entry.rule.label,
    hits: entry.total,
  })),
  details: [...findings.values()].map((entry) => ({
    rule: entry.rule.id,
    severity: entry.rule.severity,
    hits: entry.total,
    samples: entry.matches,
  })),
};

console.log(JSON.stringify(report, null, 2));

// 开发/诊断脚本共享的 CDP 端口解析：
//   --port <n>   手动指定
//   --port auto  从 ChatGPT.exe 命令行读取 --remote-debugging-port（默认）
// 读取失败时回退 9229。
import { execFile } from "node:child_process";

export const DEFAULT_CDP_PORT = 9229;

export function portArgOf(argv, fallback = "auto") {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--port") {
      const value = String(argv[index + 1] || "").trim().toLowerCase();
      if (value) return value;
    }
  }
  return fallback;
}

export function parsePortsFromCommandLines(text) {
  const ports = new Set();
  const re = /--remote-debugging-port=(\d{1,5})\b/gi;
  let match;
  while ((match = re.exec(String(text || "")))) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

function readCodexProcessCommandLines(timeoutMs) {
  return new Promise((resolve, reject) => {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | ForEach-Object { $_.CommandLine }";
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout || ""))),
    );
  });
}

export async function resolveCdpPort(requested = "auto", { timeoutMs = 6000 } = {}) {
  const raw = String(requested || "auto").trim().toLowerCase();
  const explicit = Number(raw);
  if (Number.isInteger(explicit) && explicit >= 1 && explicit <= 65535) return explicit;
  try {
    const ports = parsePortsFromCommandLines(await readCodexProcessCommandLines(timeoutMs));
    if (ports.length) return ports[0];
  } catch {
    // 读不到进程命令行时走兜底
  }
  return DEFAULT_CDP_PORT;
}

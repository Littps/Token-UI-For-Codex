import fs from "node:fs";
import path from "node:path";

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

const stateDir = argValue("--state-dir");
const lockFile = argValue("--lock-file");
const heartbeatFile = argValue("--heartbeat-file");
const logDir = argValue("--log-dir");
const historyDir = argValue("--history-dir");
for (const directory of [
  stateDir,
  logDir,
  historyDir,
  path.dirname(lockFile),
  path.dirname(heartbeatFile),
]) {
  fs.mkdirSync(directory, { recursive: true });
}

const startedAt = new Date().toISOString();
const writeJson = (file, value) => {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\r\n`, "utf8");
  fs.rmSync(file, { force: true });
  fs.renameSync(temp, file);
};

writeJson(lockFile, { pid: process.pid, startedAt });

let heartbeatSeq = 0;
function heartbeat() {
  heartbeatSeq += 1;
  const value = {
    schemaVersion: 1,
    pid: process.pid,
    startedAt,
    heartbeatAt: new Date().toISOString(),
    heartbeatSeq,
    phase: "running",
    scriptPath: path.resolve(process.argv[1]),
    codexHome: process.env.CODEX_HOME || "",
    stateDir,
  };
  writeJson(heartbeatFile, value);
}

heartbeat();
setInterval(heartbeat, 100);
setInterval(() => {}, 60_000);

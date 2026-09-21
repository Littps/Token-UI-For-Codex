export const PROTOCOL_NAME = "tokens-ui-for-codex";
export const PROTOCOL_SCHEMA_VERSION = 2;
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([PROTOCOL_SCHEMA_VERSION]);

export const PROTOCOL_CAPABILITIES = Object.freeze([
  "session-total",
  "current-prompt-total",
  "request-count",
  "cache-split",
  "context-usage",
  "turn-summaries",
  "request-details",
  "health-snapshot",
]);

export const HEALTH_STATUSES = Object.freeze([
  "starting",
  "healthy",
  "waiting-for-cdp",
  "waiting-for-page",
  "waiting-for-data",
  "target-selection-required",
  "protocol-mismatch",
  "stale-data",
  "recovering",
  "failed",
]);

export const RECOVERY_STATES = Object.freeze([
  "idle",
  "retrying",
  "recovered",
  "failed",
]);

export const TARGET_MODES = Object.freeze(["auto", "focused", "manual"]);
export const TARGET_SELECTIONS = Object.freeze(["unknown", "single", "focused", "visible", "manual", "required"]);
export const INSTALL_STATES = Object.freeze(["unknown", "missing", "ready", "invalid"]);

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

function isNullableNonNegativeNumber(value) {
  return value == null || isNonNegativeNumber(value);
}

function isNullableString(value) {
  return value == null || typeof value === "string";
}

export function makeHealth(overrides = {}) {
  return {
    status: "starting",
    recoveryState: "idle",
    platform: "windows",
    platformSupported: true,
    nodeSupported: true,
    cdpReachable: false,
    pageAttached: false,
    targetMode: "auto",
    targetSelection: "unknown",
    targetCount: 0,
    dataFresh: false,
    lastSuccessAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    monitorRunning: true,
    // 已废弃：守护进程在「自启架构调整」中移除，此字段自那时起恒为 null。
    // 保留是为了向后兼容——旧页面会读它，schema 也仍然声明它。
    guardianRunning: null,
    autostartInstalled: null,
    installationState: "ready",
    ...overrides,
  };
}

export function validateHealth(health) {
  const errors = [];
  if (!health || typeof health !== "object" || Array.isArray(health)) return ["health must be an object"];
  if (typeof health.status !== "string" || !HEALTH_STATUSES.includes(health.status)) {
    errors.push("health.status is invalid");
  }
  if (typeof health.recoveryState !== "string" || !RECOVERY_STATES.includes(health.recoveryState)) {
    errors.push("health.recoveryState is invalid");
  }
  if (health.platform !== "windows") errors.push("health.platform must be windows");
  for (const key of ["platformSupported", "nodeSupported", "cdpReachable", "pageAttached", "dataFresh", "monitorRunning"]) {
    if (typeof health[key] !== "boolean") errors.push("health." + key + " must be boolean");
  }
  if (typeof health.targetMode !== "string" || !TARGET_MODES.includes(health.targetMode)) {
    errors.push("health.targetMode is invalid");
  }
  if (typeof health.targetSelection !== "string" || !TARGET_SELECTIONS.includes(health.targetSelection)) {
    errors.push("health.targetSelection is invalid");
  }
  if (!Number.isInteger(health.targetCount) || health.targetCount < 0) {
    errors.push("health.targetCount must be a non-negative integer");
  }
  for (const key of ["lastSuccessAt", "lastErrorAt", "lastErrorCode"]) {
    if (!isNullableString(health[key])) errors.push("health." + key + " must be null or a string");
  }
  for (const key of ["guardianRunning", "autostartInstalled"]) {
    if (health[key] != null && typeof health[key] !== "boolean") errors.push("health." + key + " must be null or boolean");
  }
  if (typeof health.installationState !== "string" || !INSTALL_STATES.includes(health.installationState)) {
    errors.push("health.installationState is invalid");
  }
  return errors;
}

function validateTurn(turn, index) {
  const errors = [];
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return ["turn[" + index + "] must be an object"];
  if (!Number.isInteger(turn.index) || turn.index < 1) errors.push("turn.index is invalid");
  if (typeof turn.startLabel !== "string") errors.push("turn.startLabel must be a string");
  if (!isNonNegativeNumber(turn.requests)) errors.push("turn.requests is invalid");
  for (const key of ["input", "output", "total"]) {
    if (!isNonNegativeNumber(turn[key])) errors.push("turn." + key + " is invalid");
  }
  for (const key of ["cached", "uncached"]) {
    if (!isNullableNonNegativeNumber(turn[key])) errors.push("turn." + key + " is invalid");
  }
  return errors;
}

function validateRequest(request, index) {
  const errors = [];
  if (!request || typeof request !== "object" || Array.isArray(request)) return ["requestDetails[" + index + "] must be an object"];
  if (!Number.isInteger(request.index) || request.index < 1) errors.push("request.index is invalid");
  if (typeof request.time !== "string") errors.push("request.time must be a string");
  for (const key of ["input", "cached", "uncached", "output", "total"]) {
    if (!isNullableNonNegativeNumber(request[key])) errors.push("request." + key + " is invalid");
  }
  return errors;
}

export function negotiateSchemaVersion(remoteVersions) {
  const offered = Array.isArray(remoteVersions) ? remoteVersions : [];
  return SUPPORTED_SCHEMA_VERSIONS.find((version) => offered.includes(version)) || null;
}

export function validatePayload(payload, { allowLegacy = true } = {}) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["payload must be an object"] };
  }
  if (payload.protocolName !== PROTOCOL_NAME) errors.push("protocolName is invalid");
  if (!Number.isInteger(payload.schemaVersion) || !SUPPORTED_SCHEMA_VERSIONS.includes(payload.schemaVersion)) {
    errors.push("unsupported schemaVersion: " + String(payload.schemaVersion));
  }
  if (!Array.isArray(payload.capabilities) || payload.capabilities.some((item) => typeof item !== "string")) {
    errors.push("capabilities must be an array of strings");
  }
  for (const key of ["requestCount", "turnTotal", "turnInput", "turnOutput", "currentTurnIndex", "turnTotalCount", "requestDetailTotal", "modelSwitchCount", "cumulativeResetCount", "turnsLimit", "requestsLimit"]) {
    if (!isNonNegativeNumber(payload[key])) errors.push(key + " must be a non-negative number");
  }
  for (const key of ["sessionTotal", "contextUsed", "modelContextWindow", "sessionInput", "sessionCached", "sessionOutput", "turnCached", "turnTps"]) {
    if (!isNullableNonNegativeNumber(payload[key])) errors.push(key + " must be null or a non-negative number");
  }
  for (const key of ["turnsTruncated", "requestDetailsTruncated", "sessionChanged"]) {
    if (typeof payload[key] !== "boolean") errors.push(key + " must be boolean");
  }
  if (!Array.isArray(payload.turns)) errors.push("turns must be an array");
  if (!Array.isArray(payload.requestDetails)) errors.push("requestDetails must be an array");
  if (Array.isArray(payload.turns)) {
    if (payload.turns.length > 1000) errors.push("turns exceeds the 1000-row limit");
    payload.turns.forEach((turn, index) => errors.push(...validateTurn(turn, index)));
  }
  if (Array.isArray(payload.requestDetails)) {
    if (payload.requestDetails.length > 1000) errors.push("requestDetails exceeds the 1000-row limit");
    payload.requestDetails.forEach((request, index) => errors.push(...validateRequest(request, index)));
  }
  if (typeof payload.updatedAt !== "string" || !payload.updatedAt) errors.push("updatedAt must be a non-empty string");
  if (payload.health != null) errors.push(...validateHealth(payload.health));
  if (!allowLegacy && payload.schemaVersion !== PROTOCOL_SCHEMA_VERSION) errors.push("legacy payloads are disabled");
  return { ok: errors.length === 0, errors };
}

export function normalizeHealth(health) {
  return makeHealth(health && typeof health === "object" ? health : {});
}

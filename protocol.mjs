export const PROTOCOL_NAME = "tokens-ui-for-codex";
// v4 起只接受 auth v2：正文、版本、时间戳、nonce、keyId 与 seq 全部进入 HMAC。
// 旧监控会因 supportedSchemaVersions 不含 4 而明确失败，安装器负责先停旧进程。
export const PROTOCOL_SCHEMA_VERSION = 4;
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([PROTOCOL_SCHEMA_VERSION]);
export const AUTH_VERSION = 2;
export const AUTH_DOMAIN = "tokens-ui-for-codex/auth-v2";
export const AUTH_KEY_BYTES = 32;
export const AUTH_KEY_ID_PATTERN = /^[0-9a-f]{32}$/;
export const AUTH_NONCE_PATTERN = /^[0-9a-f]{32}$/;
export const AUTH_MAC_PATTERN = /^[0-9a-f]{64}$/;

export const PROTOCOL_CAPABILITIES = Object.freeze([
  "session-total",
  "current-prompt-total",
  "request-count",
  "cache-split",
  "context-usage",
  "speed-estimate",
  "effective-speed",
  "turn-summaries",
  "request-details",
  "health-snapshot",
  "current-turn-request-count",
  "signed-payload",
  "auth-v2",
  "robust-speed",
  "timing-v1",
  "history-range-v1",
  "context-breakdown-estimated-v1",
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

export const RECOVERY_STATES = Object.freeze(["idle", "retrying", "recovered", "failed"]);

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

export function canonicalJson(value, stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new TypeError("canonicalJson does not support cyclic arrays");
    stack.add(value);
    const serialized = "[" + value.map((item) => canonicalJson(item, stack)).join(",") + "]";
    stack.delete(value);
    return serialized;
  }
  if (value && typeof value === "object") {
    if (stack.has(value)) throw new TypeError("canonicalJson does not support cyclic objects");
    stack.add(value);
    const serialized =
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key], stack))
        .join(",") +
      "}";
    stack.delete(value);
    return serialized;
  }
  throw new TypeError("canonicalJson does not support " + typeof value);
}

export function authSigningText(body, authCore) {
  return (
    AUTH_DOMAIN +
    "\n" +
    canonicalJson(body) +
    "\n" +
    canonicalJson({
      v: authCore.v,
      keyId: authCore.keyId,
      ts: authCore.ts,
      nonce: authCore.nonce,
      seq: authCore.seq,
    })
  );
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
  for (const key of [
    "platformSupported",
    "nodeSupported",
    "cdpReachable",
    "pageAttached",
    "dataFresh",
    "monitorRunning",
  ]) {
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
  for (const key of ["autostartInstalled"]) {
    if (health[key] != null && typeof health[key] !== "boolean")
      errors.push("health." + key + " must be null or boolean");
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
  for (const key of ["wallMs", "toolWallMs", "ttftMs", "timingCoverage"]) {
    if (turn[key] != null && !isNullableNonNegativeNumber(turn[key])) errors.push("turn." + key + " is invalid");
  }
  if (turn.toolCallCount != null && !isNonNegativeNumber(turn.toolCallCount)) {
    errors.push("turn.toolCallCount is invalid");
  }
  if (turn.timingQuality != null && !["high", "medium", "low"].includes(turn.timingQuality)) {
    errors.push("turn.timingQuality is invalid");
  }
  if (turn.input != null && turn.cached != null && turn.cached > turn.input) errors.push("turn.cached exceeds input");
  return errors;
}

function validateContextBreakdown(value) {
  if (value == null) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["contextBreakdown must be null or an object"];
  }
  const errors = [];
  if (value.estimated !== true) errors.push("contextBreakdown.estimated must be true");
  if (!Number.isInteger(value.estimatorVersion) || value.estimatorVersion < 1) {
    errors.push("contextBreakdown.estimatorVersion is invalid");
  }
  for (const key of ["systemPromptTokens", "toolDefinitionTokens", "conversationTokens", "otherTokens"]) {
    if (value[key] != null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) {
      errors.push("contextBreakdown." + key + " is invalid");
    }
  }
  return errors;
}

function validateRangeSummary(summary) {
  if (summary == null) return [];
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return ["rangeSummary must be null or an object"];
  }
  const errors = [];
  if (!["today", "3d", "7d", "30d", "all"].includes(summary.range)) {
    errors.push("rangeSummary.range is invalid");
  }
  if (typeof summary.available !== "boolean") errors.push("rangeSummary.available must be boolean");
  if (typeof summary.cacheComplete !== "boolean") errors.push("rangeSummary.cacheComplete must be boolean");
  for (const key of [
    "retentionDays",
    "sessionCount",
    "turnCount",
    "requestCount",
    "input",
    "cached",
    "output",
    "total",
    "toolCallCount",
    "timingSampleCount",
    "ttftSampleCount",
  ]) {
    if (!isNonNegativeNumber(summary[key])) errors.push("rangeSummary." + key + " is invalid");
  }
  for (const key of ["ttftAvgMs", "effectiveMs", "effectiveTps"]) {
    if (!isNullableNonNegativeNumber(summary[key])) errors.push("rangeSummary." + key + " is invalid");
  }
  for (const key of ["wallMs", "toolWallMs"]) {
    if (!isNullableNonNegativeNumber(summary[key])) errors.push("rangeSummary." + key + " is invalid");
  }
  for (const key of ["cutoffAt", "generatedAt", "availableFrom", "availableThrough"]) {
    if (summary[key] != null && (typeof summary[key] !== "string" || !Number.isFinite(Date.parse(summary[key])))) {
      errors.push("rangeSummary." + key + " is invalid");
    }
  }
  return errors;
}

function validateRequest(request, index) {
  const errors = [];
  if (!request || typeof request !== "object" || Array.isArray(request))
    return ["requestDetails[" + index + "] must be an object"];
  if (!Number.isInteger(request.index) || request.index < 1) errors.push("request.index is invalid");
  if (typeof request.time !== "string") errors.push("request.time must be a string");
  for (const key of ["input", "cached", "uncached", "output", "total"]) {
    if (!isNullableNonNegativeNumber(request[key])) errors.push("request." + key + " is invalid");
  }
  if (request.input != null && request.cached != null && request.cached > request.input) {
    errors.push("request.cached exceeds input");
  }
  return errors;
}

function validateAuth(auth) {
  const errors = [];
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return ["auth must be an object"];
  if (auth.v !== AUTH_VERSION) errors.push("auth.v is invalid");
  if (!Number.isSafeInteger(auth.ts) || auth.ts < 0) errors.push("auth.ts is invalid");
  if (typeof auth.keyId !== "string" || !AUTH_KEY_ID_PATTERN.test(auth.keyId)) errors.push("auth.keyId is invalid");
  if (typeof auth.nonce !== "string" || !AUTH_NONCE_PATTERN.test(auth.nonce)) errors.push("auth.nonce is invalid");
  if (!Number.isSafeInteger(auth.seq) || auth.seq < 1) errors.push("auth.seq is invalid");
  if (typeof auth.mac !== "string" || !AUTH_MAC_PATTERN.test(auth.mac)) errors.push("auth.mac is invalid");
  return errors;
}

export function negotiateSchemaVersion(remoteVersions) {
  const offered = Array.isArray(remoteVersions) ? remoteVersions : [];
  return SUPPORTED_SCHEMA_VERSIONS.find((version) => offered.includes(version)) || null;
}

export function validatePayload(payload, { allowLegacy = true, requireAuth = false } = {}) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["payload must be an object"] };
  }
  if (payload.protocolName !== PROTOCOL_NAME) errors.push("protocolName is invalid");
  if (!Number.isInteger(payload.schemaVersion) || !SUPPORTED_SCHEMA_VERSIONS.includes(payload.schemaVersion)) {
    errors.push("unsupported schemaVersion: " + String(payload.schemaVersion));
  }
  if (payload.authRequired !== true) errors.push("authRequired must be true");
  if (requireAuth) errors.push(...validateAuth(payload.auth));
  if (!Array.isArray(payload.capabilities) || payload.capabilities.some((item) => typeof item !== "string")) {
    errors.push("capabilities must be an array of strings");
  } else if (!payload.capabilities.includes("auth-v2")) {
    errors.push("capabilities must include auth-v2");
  }
  for (const key of [
    "requestCount",
    "currentTurnRequestCount",
    "turnTotal",
    "turnInput",
    "turnOutput",
    "currentTurnIndex",
    "turnTotalCount",
    "requestDetailTotal",
    "modelSwitchCount",
    "cumulativeResetCount",
    "turnsLimit",
    "requestsLimit",
  ]) {
    if (!isNonNegativeNumber(payload[key])) errors.push(key + " must be a non-negative number");
  }
  for (const key of ["compactSpeedSampleCount", "compactSpeedWindow"]) {
    if (payload[key] != null && !isNonNegativeNumber(payload[key])) errors.push(key + " must be a non-negative number");
  }
  for (const key of [
    "sessionTotal",
    "contextUsed",
    "modelContextWindow",
    "sessionInput",
    "sessionCached",
    "sessionOutput",
    "sessionCacheHitRate",
    "turnCached",
    "turnCacheHitRate",
    "turnTps",
    "turnWallTps",
    "turnWallMs",
    "turnToolWallMs",
    "turnTtftMs",
    "turnTimingCoverage",
    "sessionTps",
    "lastRequestTps",
    "genEstimateTps",
    "compactTps",
    "effectiveTps",
    "turnEffectiveTps",
  ]) {
    if (!isNullableNonNegativeNumber(payload[key])) errors.push(key + " must be null or a non-negative number");
  }
  for (const key of ["effectiveSampleCount", "effectiveWindow"]) {
    if (!isNonNegativeNumber(payload[key])) errors.push(key + " must be a non-negative number");
  }
  for (const key of ["sessionWallMs", "sessionToolWallMs", "sessionTtftAvgMs"]) {
    if (payload[key] != null && !isNullableNonNegativeNumber(payload[key]))
      errors.push(key + " must be null or a non-negative number");
  }
  for (const key of ["sessionToolCallCount", "sessionTimingSampleCount"]) {
    if (payload[key] != null && !isNonNegativeNumber(payload[key])) errors.push(key + " must be a non-negative number");
  }
  if (payload.turnToolCallCount != null && !isNonNegativeNumber(payload.turnToolCallCount)) {
    errors.push("turnToolCallCount must be a non-negative number");
  }
  if (payload.turnTimingQuality != null && !["high", "medium", "low"].includes(payload.turnTimingQuality)) {
    errors.push("turnTimingQuality is invalid");
  }
  errors.push(...validateContextBreakdown(payload.contextBreakdown));
  errors.push(...validateRangeSummary(payload.rangeSummary));
  if (payload.contextBreakdown && Number.isFinite(payload.contextUsed)) {
    const breakdown = payload.contextBreakdown;
    const breakdownTotal =
      (breakdown.systemPromptTokens || 0) +
      (breakdown.toolDefinitionTokens || 0) +
      (breakdown.conversationTokens || 0) +
      (breakdown.otherTokens || 0);
    if (breakdownTotal !== Math.floor(payload.contextUsed)) {
      errors.push("contextBreakdown total must equal floor(contextUsed)");
    }
  }
  for (const key of ["sessionCacheHitRate", "turnCacheHitRate"]) {
    if (payload[key] != null && (!isNonNegativeNumber(payload[key]) || payload[key] > 1)) {
      errors.push(key + " must be null or between 0 and 1");
    }
  }
  if (payload.speedTimingConfidence != null && !["high", "medium", "low"].includes(payload.speedTimingConfidence)) {
    errors.push("speedTimingConfidence is invalid");
  }
  if (payload.compactSpeedConfidence != null && !["high", "medium", "low"].includes(payload.compactSpeedConfidence)) {
    errors.push("compactSpeedConfidence is invalid");
  }
  for (const key of ["turnsTruncated", "requestDetailsTruncated", "sessionChanged", "snapshot"]) {
    if (typeof payload[key] !== "boolean") errors.push(key + " must be boolean");
  }
  if (!Array.isArray(payload.turns)) errors.push("turns must be an array");
  if (!Array.isArray(payload.requestDetails)) errors.push("requestDetails must be an array");
  if (Array.isArray(payload.turns)) {
    if (payload.turns.length > 500) errors.push("turns exceeds the 500-row limit");
    payload.turns.forEach((turn, index) => errors.push(...validateTurn(turn, index)));
  }
  if (Array.isArray(payload.requestDetails)) {
    if (payload.requestDetails.length > 500) errors.push("requestDetails exceeds the 500-row limit");
    payload.requestDetails.forEach((request, index) => errors.push(...validateRequest(request, index)));
  }
  if (Array.isArray(payload.turns) && payload.turnTotalCount < payload.turns.length) {
    errors.push("turnTotalCount is smaller than turns.length");
  }
  if (Array.isArray(payload.requestDetails) && payload.requestDetailTotal < payload.requestDetails.length) {
    errors.push("requestDetailTotal is smaller than requestDetails.length");
  }
  if (payload.currentTurnIndex > payload.turnTotalCount) {
    errors.push("currentTurnIndex exceeds turnTotalCount");
  }
  for (const [label, input, cached] of [
    ["session", payload.sessionInput, payload.sessionCached],
    ["turn", payload.turnInput, payload.turnCached],
  ]) {
    if (input != null && cached != null && cached > input) errors.push(label + ".cached exceeds input");
  }
  if (typeof payload.updatedAt !== "string" || !Number.isFinite(Date.parse(payload.updatedAt))) {
    errors.push("updatedAt must be a valid ISO timestamp");
  }
  if (!payload.health) errors.push("health is required");
  else errors.push(...validateHealth(payload.health));
  if (!allowLegacy && payload.schemaVersion !== PROTOCOL_SCHEMA_VERSION) errors.push("legacy payloads are disabled");
  return { ok: errors.length === 0, errors };
}

export function normalizeHealth(health) {
  return makeHealth(health && typeof health === "object" ? health : {});
}

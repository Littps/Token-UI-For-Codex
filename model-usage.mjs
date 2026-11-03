import { getSupportedModels, resolveOpenRouterModel } from "./openrouter-pricing.mjs";

const labels = new Map(getSupportedModels().map((model) => [model.modelId, model.modelLabel]));
export const MODEL_COST_STATUSES = Object.freeze([
  "priced",
  "partial",
  "unknown-model",
  "missing-price",
  "missing-usage",
  "stale-price",
  "unavailable",
  "unsupported-tier",
  "unknown-mode",
]);

export function modelIdentity(value) {
  const modelId = resolveOpenRouterModel(value);
  return { modelId, modelLabel: labels.get(modelId) || "未知模型" };
}

export function requestModelMetadata(request = {}) {
  const identity = modelIdentity(request.modelId ?? request.model);
  const cost =
    typeof request.openRouterReferenceUsd === "number" &&
    Number.isFinite(request.openRouterReferenceUsd) &&
    request.openRouterReferenceUsd >= 0 &&
    ["priced", "stale-price"].includes(request.costStatus)
      ? request.openRouterReferenceUsd
      : null;
  return {
    ...identity,
    openRouterReferenceUsd: identity.modelId ? cost : null,
    pricingFetchedAt:
      typeof request.pricingFetchedAt === "string" && Number.isFinite(Date.parse(request.pricingFetchedAt))
        ? request.pricingFetchedAt
        : null,
    costStatus: identity.modelId
      ? MODEL_COST_STATUSES.includes(request.costStatus)
        ? request.costStatus
        : "unavailable"
      : "unknown-model",
  };
}

// Fold final, F1-deduplicated requests only. Missing counters stay unknown.
export function aggregateModelUsage(requests) {
  const rows = requests.map((request) => {
    const metadata = requestModelMetadata(request);
    const priced = metadata.openRouterReferenceUsd !== null;
    return {
      ...metadata,
      input: request.input ?? null,
      cached: request.cached ?? null,
      output: request.output ?? null,
      total: request.requestTotal ?? request.lastTotal ?? request.total ?? null,
      requestCount: 1,
      pricedRequestCount: priced ? 1 : 0,
      unpricedRequestCount: priced ? 0 : 1,
    };
  });
  return mergeModelUsage(rows);
}

export function mergeModelUsage(rows) {
  const groups = new Map();
  for (const row of rows) {
    const identity = modelIdentity(row.modelId);
    const key = identity.modelId || "unknown";
    let group = groups.get(key);
    if (!group) {
      group = {
        ...identity,
        input: 0,
        cached: 0,
        output: 0,
        total: 0,
        requestCount: 0,
        openRouterReferenceUsd: null,
        pricedRequestCount: 0,
        unpricedRequestCount: 0,
        costStatus: "unavailable",
        pricingFetchedAt: row.pricingFetchedAt ?? null,
      };
      groups.set(key, group);
    }
    for (const field of ["input", "cached", "output", "total"]) {
      group[field] =
        group[field] !== null && Number.isFinite(row[field]) && row[field] >= 0 ? group[field] + row[field] : null;
    }
    const count = Number.isSafeInteger(row.requestCount) && row.requestCount >= 0 ? row.requestCount : 0;
    const pricedCount =
      identity.modelId &&
      Number.isSafeInteger(row.pricedRequestCount) &&
      row.pricedRequestCount >= 0 &&
      row.pricedRequestCount <= count &&
      Number.isFinite(row.openRouterReferenceUsd) &&
      row.openRouterReferenceUsd >= 0
        ? row.pricedRequestCount
        : 0;
    group.requestCount += count;
    group.pricedRequestCount += pricedCount;
    group.unpricedRequestCount += count - pricedCount;
    if (pricedCount > 0)
      group.openRouterReferenceUsd = (group.openRouterReferenceUsd ?? 0) + row.openRouterReferenceUsd;
    if (group.pricingFetchedAt !== (row.pricingFetchedAt ?? null)) group.pricingFetchedAt = null;
    group.costStatus =
      group.pricedRequestCount === 0 ? "unavailable" : group.unpricedRequestCount > 0 ? "partial" : "priced";
  }
  return [...groups.values()];
}

export function unknownModelUsage(turn) {
  return mergeModelUsage([
    {
      modelId: null,
      input: turn.input ?? null,
      cached: turn.cached ?? null,
      output: turn.output ?? null,
      total: turn.total ?? null,
      requestCount: Number.isSafeInteger(turn.requests) ? turn.requests : (turn.requestCount ?? 0),
    },
  ]);
}

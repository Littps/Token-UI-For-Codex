import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveServiceTierRate } from "./service-tier-pricing.mjs";

export const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const PRICE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PRICE_FETCH_TIMEOUT_MS = 10_000;
const MODEL_NAMES = [
  ["gpt-6.1-sol", "GPT-6.1 Sol"],
  ["gpt-6-astra", "GPT-6 Astra"],
  ["gpt-6.1-terra", "GPT-6.1 Terra"],
  ["gpt-6-sol", "GPT-6 Sol"],
  ["gpt-6-luna", "GPT-6 Luna"],
  ["gpt-5.6-sol", "GPT-5.6 Sol"],
  ["gpt-5.6-terra", "GPT-5.6 Terra"],
  ["gpt-5.6-luna", "GPT-5.6 Luna"],
];
const aliases = new Map(
  MODEL_NAMES.flatMap(([id]) => [
    [id, `openai/${id}`],
    [`openai/${id}`, `openai/${id}`],
  ]),
);
const PRICE_FIELDS = ["prompt", "completion", "input_cache_read", "input_cache_write"];
const pendingLoads = new Map();

export function getSupportedModels() {
  return MODEL_NAMES.map(([id, modelLabel]) => ({ modelId: `openai/${id}`, modelLabel }));
}

export function resolveOpenRouterModel(modelValue) {
  return typeof modelValue === "string" ? (aliases.get(modelValue) ?? null) : null;
}

function priceNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && (!value.trim() || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)))
    return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function cleanPricing(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pricing = Object.fromEntries(PRICE_FIELDS.map((key) => [key, priceNumber(value[key])]));
  const overrides = [];
  let invalidOverrides = false;
  if (value.overrides != null && !Array.isArray(value.overrides)) invalidOverrides = true;
  for (const row of Array.isArray(value.overrides) ? value.overrides : []) {
    if (!row || !Number.isSafeInteger(row.min_prompt_tokens) || row.min_prompt_tokens < 0) {
      invalidOverrides = true;
      continue;
    }
    const rates = Object.fromEntries(PRICE_FIELDS.map((key) => [key, priceNumber(row[key])]));
    if (
      rates.prompt === null ||
      rates.completion === null ||
      overrides.some((r) => r.min_prompt_tokens === row.min_prompt_tokens)
    ) {
      invalidOverrides = true;
    }
    overrides.push({ min_prompt_tokens: row.min_prompt_tokens, ...rates });
  }
  return {
    ...pricing,
    overrides: overrides.sort((a, b) => a.min_prompt_tokens - b.min_prompt_tokens),
    invalidOverrides,
  };
}

export function parseOpenRouterCatalog(payload, fetchedAt = Date.now()) {
  if (!payload || !Array.isArray(payload.data)) throw new Error("invalid-catalog");
  const timestamp = typeof fetchedAt === "number" ? fetchedAt : Date.parse(fetchedAt);
  if (!Number.isFinite(timestamp)) throw new Error("invalid-catalog-time");
  const modelsById = {};
  const seen = new Set();
  for (const row of payload.data) {
    const modelId = resolveOpenRouterModel(row?.id);
    if (!modelId || row.id !== modelId) continue;
    if (seen.has(modelId)) {
      delete modelsById[modelId];
      continue;
    }
    seen.add(modelId);
    const pricing = cleanPricing(row.pricing);
    if (!pricing) continue;
    modelsById[modelId] = {
      modelId,
      modelLabel: getSupportedModels().find((m) => m.modelId === modelId).modelLabel,
      pricing,
    };
  }
  return {
    schemaVersion: 1,
    sourceUrl: OPENROUTER_CATALOG_URL,
    fetchedAt: new Date(timestamp).toISOString(),
    modelsById,
  };
}

function validateCachedCatalog(value, now) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.sourceUrl !== OPENROUTER_CATALOG_URL ||
    !value.modelsById ||
    Array.isArray(value.modelsById)
  ) {
    return null;
  }
  const time = Date.parse(value.fetchedAt);
  if (!Number.isFinite(time) || time > now) return null;
  const rebuilt = parseOpenRouterCatalog(
    { data: Object.entries(value.modelsById).map(([id, model]) => ({ id, pricing: model?.pricing })) },
    time,
  );
  // Keep a deliberately invalid override marker through cache validation.
  for (const [id, model] of Object.entries(rebuilt.modelsById)) {
    model.pricing.invalidOverrides ||= value.modelsById[id]?.pricing?.invalidOverrides === true;
  }
  return hasUsableModel(rebuilt) ? rebuilt : null;
}

function hasUsableModel(catalog) {
  return Object.values(catalog.modelsById).some(
    ({ pricing }) => pricing.prompt !== null && pricing.completion !== null,
  );
}

async function writeSnapshot(cacheFile, catalog) {
  if (!cacheFile) return;
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  const temporary = `${cacheFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(catalog), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, cacheFile);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function loadCatalog({
  cacheFile,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  maxAgeMs = PRICE_CACHE_MAX_AGE_MS,
  timeoutMs = PRICE_FETCH_TIMEOUT_MS,
}) {
  const clock = typeof now === "function" ? now() : now;
  let cached = null;
  if (cacheFile) {
    try {
      cached = validateCachedCatalog(JSON.parse(await fs.readFile(cacheFile, "utf8")), clock);
    } catch {
      /* A corrupt cache is never trusted or deleted. */
    }
  }
  if (cached && clock - Date.parse(cached.fetchedAt) <= maxAgeMs) {
    return { catalog: cached, status: "fresh", fetchedAt: cached.fetchedAt, errorCode: null };
  }
  let errorCode = null;
  try {
    const response = await fetchImpl(OPENROUTER_CATALOG_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      errorCode = Number.isInteger(response.status) ? `http-${response.status}` : "http-error";
      throw new Error("catalog-http-error");
    }
    let json;
    try {
      json = await response.json();
    } catch {
      errorCode = "invalid-json";
      throw new Error("invalid-json");
    }
    let catalog;
    try {
      catalog = parseOpenRouterCatalog(json, clock);
    } catch {
      errorCode = "invalid-catalog";
      throw new Error("invalid-catalog");
    }
    if (!hasUsableModel(catalog)) {
      errorCode = "invalid-catalog";
      throw new Error("invalid-catalog");
    }
    try {
      await writeSnapshot(cacheFile, catalog);
    } catch {
      errorCode = "cache-write-failed";
    }
    return { catalog, status: "fresh", fetchedAt: catalog.fetchedAt, errorCode };
  } catch (error) {
    errorCode ||= ["TimeoutError", "AbortError"].includes(error?.name) ? "timeout" : "network-error";
    return {
      catalog: cached,
      status: cached ? "stale" : "unavailable",
      fetchedAt: cached?.fetchedAt ?? null,
      errorCode,
    };
  }
}

export async function loadOpenRouterCatalog(options = {}) {
  const key = options.cacheFile;
  if (key && pendingLoads.has(key)) return pendingLoads.get(key);
  const pending = loadCatalog(options);
  if (key) pendingLoads.set(key, pending);
  try {
    return await pending;
  } finally {
    if (key && pendingLoads.get(key) === pending) pendingLoads.delete(key);
  }
}

function tokenNumber(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cacheWrites(request, excluded) {
  const hasSingle = request.cacheWrite != null;
  const hasSplit = request.cacheWrite30m != null || request.cacheWrite12h != null;
  if (hasSingle && hasSplit) return null;
  if (hasSingle) return tokenNumber(request.cacheWrite);
  if (hasSplit) {
    const a = tokenNumber(request.cacheWrite30m);
    const b = tokenNumber(request.cacheWrite12h);
    return a === null || b === null ? null : a + b;
  }
  return excluded ? 0 : null;
}

function calculate(input, cached, output, writes, rates) {
  const ordinary = input - cached - writes;
  if (ordinary < 0 || !rates) return null;
  const categories = [
    [ordinary, rates.prompt],
    [cached, rates.input_cache_read],
    [writes, rates.input_cache_write],
    [output, rates.completion],
  ];
  if (
    categories.some(([tokens, rate]) => tokens > 0 && (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0))
  )
    return null;
  const result = categories.reduce((sum, [tokens, rate]) => sum + (tokens === 0 ? 0 : tokens * rate), 0);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

export function estimateRequestCost(request = {}, modelPricing, options = {}) {
  const billingContext = options.billingContext ?? "openrouter-api";
  const serviceTier = options.serviceTier ?? request.serviceTier ?? null;
  const cacheWriteTtl = options.cacheWriteTtl ?? request.cacheWriteTtl ?? null;
  const result = {
    openRouterReferenceUsd: null,
    apiCostUsd: null,
    subscriptionAllowanceWeight: null,
    subscriptionWeightedReferenceUsd: null,
    pricingBasis: "openrouter-public-base",
    serviceTier,
    cacheWriteTtl,
    status: "missing-price",
  };
  const modelId = resolveOpenRouterModel(request.model ?? request.modelId);
  if (!modelId) return { ...result, status: "unknown-model" };
  if (
    !["openrouter-api", "openai-api", "codex-subscription-allowance", "codex-purchased-credits"].includes(
      billingContext,
    )
  ) {
    return { ...result, status: "unknown-mode" };
  }
  if (!modelPricing || (modelPricing.modelId && modelPricing.modelId !== modelId)) return result;
  const pricing = modelPricing.pricing ?? modelPricing;
  const input = tokenNumber(request.input);
  const cached = tokenNumber(request.cached);
  const output = tokenNumber(request.output);
  const writes = cacheWrites(request, options.cacheWritePolicy === "excluded");
  if ([input, cached, output, writes].includes(null) || cached + writes > input)
    return { ...result, status: "missing-usage" };
  const subscription = ["codex-subscription-allowance", "codex-purchased-credits"].includes(billingContext);
  let rate = pricing;
  if (!subscription) {
    if (pricing.invalidOverrides) return { ...result, status: "unsupported-tier" };
    for (const row of pricing.overrides ?? []) if (input >= row.min_prompt_tokens) rate = row;
  }
  const unsupportedReferenceTtl =
    !subscription && ((cacheWriteTtl === "12h" && writes > 0) || request.cacheWrite12h > 0);
  if (unsupportedReferenceTtl && billingContext !== "openai-api") {
    return { ...result, status: "unsupported-tier" };
  }
  if (billingContext === "openrouter-api" && serviceTier && serviceTier !== "standard")
    return { ...result, status: "unsupported-tier" };
  result.openRouterReferenceUsd = unsupportedReferenceTtl
    ? null
    : calculate(input, cached, output, subscription ? 0 : writes, rate);
  if (result.openRouterReferenceUsd !== null)
    result.status = options.pricingStatus === "stale" ? "stale-price" : "priced";
  if (billingContext === "openai-api") {
    const resolved = resolveServiceTierRate({
      billingContext,
      modelId,
      serviceTier,
      cacheWriteTtl,
      inputTokens: input,
      profile: options.profile,
      now: options.now,
    });
    result.apiCostUsd = resolved.rate ? calculate(input, cached, output, writes, resolved.rate) : null;
    result.status = result.apiCostUsd === null ? resolved.status : "priced";
  }
  // Subscription weighting is intentionally unavailable without an independently
  // verified funding/mode profile. Public API reference is not a subscription bill.
  return result;
}

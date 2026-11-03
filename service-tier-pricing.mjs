// Rates for modes not present in the public catalog are never inferred from base prices.
// A caller may supply an explicitly verified, versioned official rate profile.
export const SERVICE_TIER_PROFILE_VERSION = 1;
export const SERVICE_TIER_PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function officialSource(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && ["developers.openai.com", "openai.com", "help.openai.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function validRate(rate) {
  return (
    rate &&
    ["prompt", "completion", "input_cache_read", "input_cache_write"].every(
      (key) => typeof rate[key] === "number" && Number.isFinite(rate[key]) && rate[key] >= 0,
    )
  );
}

export function resolveServiceTierRate({
  billingContext,
  modelId,
  serviceTier,
  cacheWriteTtl,
  inputTokens,
  profile,
  now = Date.now(),
  maxAgeMs = SERVICE_TIER_PROFILE_MAX_AGE_MS,
} = {}) {
  const empty = { rate: null, multiplier: null, verifiedAt: null, sourceUrl: null, status: "unsupported-tier" };
  if (!profile || profile.schemaVersion !== SERVICE_TIER_PROFILE_VERSION || !officialSource(profile.sourceUrl)) {
    return empty;
  }
  const verifiedAt = Date.parse(profile.verifiedAt);
  const clock = typeof now === "function" ? now() : now;
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(clock) || verifiedAt > clock || clock - verifiedAt > maxAgeMs) {
    return { ...empty, status: "stale-price" };
  }
  if (!Array.isArray(profile.rates)) return empty;
  const matches = profile.rates.filter(
    (row) =>
      row.modelId === modelId &&
      row.billingContext === billingContext &&
      row.serviceTier === serviceTier &&
      (row.cacheWriteTtl ?? null) === (cacheWriteTtl ?? null) &&
      ((row.minPromptTokens == null && row.maxPromptTokens == null) ||
        (Number.isSafeInteger(inputTokens) &&
          inputTokens >= 0 &&
          (row.minPromptTokens == null ||
            (Number.isSafeInteger(row.minPromptTokens) && inputTokens >= row.minPromptTokens)) &&
          (row.maxPromptTokens == null ||
            (Number.isSafeInteger(row.maxPromptTokens) && inputTokens <= row.maxPromptTokens)))),
  );
  if (matches.length !== 1 || !validRate(matches[0].rate)) return empty;
  return {
    rate: Object.fromEntries(
      ["prompt", "completion", "input_cache_read", "input_cache_write"].map((key) => [key, matches[0].rate[key]]),
    ),
    multiplier: null,
    verifiedAt: new Date(verifiedAt).toISOString(),
    sourceUrl: profile.sourceUrl,
    status: "priced",
  };
}

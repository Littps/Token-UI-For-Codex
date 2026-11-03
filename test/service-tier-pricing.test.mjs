import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveServiceTierRate } from "../service-tier-pricing.mjs";

const now = Date.parse("2026-11-03T08:00:00Z");
const profile = {
  schemaVersion: 1,
  verifiedAt: new Date(now).toISOString(),
  sourceUrl: "https://developers.openai.com/api/docs/pricing",
  rates: [
    {
      modelId: "openai/gpt-6.1-sol",
      billingContext: "openai-api",
      serviceTier: "fast",
      cacheWriteTtl: "12h",
      rate: { prompt: 4e-6, completion: 20e-6, input_cache_read: 0.2e-6, input_cache_write: 10e-6 },
    },
  ],
};

test("exact versioned official profiles resolve without generic multipliers", () => {
  const resolved = resolveServiceTierRate({
    billingContext: "openai-api",
    modelId: "openai/gpt-6.1-sol",
    serviceTier: "fast",
    cacheWriteTtl: "12h",
    profile,
    now,
  });
  assert.equal(resolved.status, "priced");
  assert.equal(resolved.rate.prompt, 4e-6);
  assert.equal(resolved.multiplier, null);
  assert.equal(resolved.sourceUrl, profile.sourceUrl);
});

test("unknown model, tier, TTL, funding basis and unverified production profile stay unknown", () => {
  const base = {
    billingContext: "openai-api",
    modelId: "openai/gpt-6.1-sol",
    serviceTier: "fast",
    cacheWriteTtl: "12h",
    profile,
    now,
  };
  for (const extra of [
    { modelId: "openai/gpt-6-sol" },
    { serviceTier: "batch" },
    { cacheWriteTtl: "30m" },
    { billingContext: "codex-subscription-allowance" },
    { profile: undefined },
  ]) {
    assert.equal(resolveServiceTierRate({ ...base, ...extra }).rate, null);
  }
});

test("expired, future, nonofficial and invalid profiles are rejected", () => {
  for (const extra of [
    { verifiedAt: new Date(now - 25 * 3600_000).toISOString() },
    { verifiedAt: new Date(now + 3600_000).toISOString() },
    { sourceUrl: "https://evil.invalid/prices" },
    { rates: [{ ...profile.rates[0], rate: { prompt: -1 } }] },
  ]) {
    const resolved = resolveServiceTierRate({
      billingContext: "openai-api",
      modelId: "openai/gpt-6.1-sol",
      serviceTier: "fast",
      cacheWriteTtl: "12h",
      profile: { ...profile, ...extra },
      now,
    });
    assert.equal(resolved.rate, null);
    assert.notEqual(resolved.status, "priced");
  }
});

test("API context tiers require an exact profile interval and select its declared min bound", () => {
  const short = { ...profile.rates[0], minPromptTokens: 0, maxPromptTokens: 271999 };
  const long = { ...profile.rates[0], minPromptTokens: 272000, rate: { ...profile.rates[0].rate, prompt: 8e-6 } };
  const p = { ...profile, rates: [short, long] };
  const base = {
    billingContext: "openai-api",
    modelId: "openai/gpt-6.1-sol",
    serviceTier: "fast",
    cacheWriteTtl: "12h",
    profile: p,
    now,
  };
  assert.equal(resolveServiceTierRate({ ...base, inputTokens: 271999 }).rate.prompt, 4e-6);
  assert.equal(resolveServiceTierRate({ ...base, inputTokens: 272000 }).rate.prompt, 8e-6);
  assert.equal(resolveServiceTierRate(base).rate, null);
});

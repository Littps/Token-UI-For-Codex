import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getSupportedModels,
  resolveOpenRouterModel,
  parseOpenRouterCatalog,
  loadOpenRouterCatalog,
  estimateRequestCost,
} from "../openrouter-pricing.mjs";

const now = Date.parse("2026-11-03T08:00:00Z");
const pricing = {
  prompt: "0.000002",
  completion: "0.00001",
  input_cache_read: "0.0000001",
  input_cache_write: "0.0000025",
  overrides: [
    {
      min_prompt_tokens: 272000,
      prompt: "0.000004",
      completion: "0.000015",
      input_cache_read: "0.0000002",
      input_cache_write: "0.000005",
    },
  ],
};
const payload = () => ({ data: getSupportedModels().map(({ modelId }) => ({ id: modelId, pricing })) });
const catalog = () => parseOpenRouterCatalog(payload(), now);
const request = (extra = {}) => ({
  model: "gpt-6.1-sol",
  input: 1000,
  cached: 400,
  output: 100,
  cacheWrite: 0,
  ...extra,
});
const model = () => catalog().modelsById["openai/gpt-6.1-sol"];

test("only the eight exact GPT aliases resolve; suffixes and unrelated models remain unknown", () => {
  assert.equal(getSupportedModels().length, 8);
  for (const { modelId } of getSupportedModels()) {
    assert.equal(resolveOpenRouterModel(modelId), modelId);
    assert.equal(resolveOpenRouterModel(modelId.slice(7)), modelId);
  }
  for (const value of ["gpt-6.1-sol-pro", "gpt-6.1-sol:batch", "prefix-gpt-6-sol", "gpt-4o", "", null]) {
    assert.equal(resolveOpenRouterModel(value), null);
  }
});

test("catalog keeps a sanitized supported-only price snapshot and context tiers", () => {
  const data = payload();
  data.data.push({ id: "other/model", pricing });
  data.data[0].description = "must not persist";
  const parsed = parseOpenRouterCatalog(data, now);
  assert.equal(Object.keys(parsed.modelsById).length, 8);
  assert.equal(model().pricing.prompt, 0.000002);
  assert.equal(model().pricing.overrides[0].min_prompt_tokens, 272000);
  assert.equal(JSON.stringify(parsed).includes("must not persist"), false);
  assert.equal(parsed.fetchedAt, new Date(now).toISOString());
});

test("invalid and missing prices remain null, never zero; duplicate model rows are ambiguous", () => {
  const data = payload();
  data.data[0].pricing = { prompt: "", completion: "-1", input_cache_read: "NaN", input_cache_write: false };
  const p = parseOpenRouterCatalog(data, now).modelsById[data.data[0].id].pricing;
  assert.equal(p.prompt, null);
  assert.equal(p.completion, null);
  assert.equal(p.input_cache_read, null);
  assert.equal(p.input_cache_write, null);
  data.data.push(data.data[0]);
  assert.equal(parseOpenRouterCatalog(data, now).modelsById[data.data[0].id], undefined);
  assert.throws(() => parseOpenRouterCatalog({ data: {} }, now));
});

test("reference calculation charges input cache classes once and never adds reasoning twice", () => {
  const result = estimateRequestCost(request({ cacheWrite: 200, reasoning: 999 }), model());
  assert.ok(Math.abs(result.openRouterReferenceUsd - (400 * 2e-6 + 400 * 1e-7 + 200 * 2.5e-6 + 100 * 1e-5)) < 1e-12);
  assert.equal(result.status, "priced");
  assert.equal(result.apiCostUsd, null);
});

test("fixed-shape parser null placeholders do not conflict with one observed cache-write representation", () => {
  const a = estimateRequestCost(request({ cacheWrite: 0, cacheWrite30m: null, cacheWrite12h: null }), model());
  assert.equal(a.status, "priced");
  const b = estimateRequestCost(request({ cacheWrite: null, cacheWrite30m: 100, cacheWrite12h: 0 }), model());
  assert.equal(b.status, "priced");
  const c = estimateRequestCost(request({ cacheWrite: null, cacheWrite30m: null, cacheWrite12h: null }), model());
  assert.equal(c.status, "missing-usage");
  const d = estimateRequestCost(request({ cacheWrite: 0, cacheWrite30m: 0, cacheWrite12h: 0 }), model());
  assert.equal(d.status, "missing-usage");
});

test("missing and invalid usage, unknown model/price and unsupported tier do not fabricate cost", () => {
  for (const extra of [
    { input: null },
    { cached: null },
    { output: null },
    { cached: 1001 },
    { input: -1 },
    { output: Infinity },
    { cacheWrite: null },
  ]) {
    assert.equal(estimateRequestCost(request(extra), model()).openRouterReferenceUsd, null);
  }
  const noWrite = request();
  delete noWrite.cacheWrite;
  assert.equal(estimateRequestCost(noWrite, model()).status, "missing-usage");
  assert.equal(estimateRequestCost(noWrite, model(), { cacheWritePolicy: "excluded" }).status, "priced");
  assert.equal(estimateRequestCost(request({ model: "gpt-4o" }), model()).status, "unknown-model");
  assert.equal(estimateRequestCost(request(), null).openRouterReferenceUsd, null);
  assert.equal(estimateRequestCost(request(), model(), { serviceTier: "fast" }).status, "unsupported-tier");
  assert.equal(
    estimateRequestCost(request({ cacheWrite: 200, cacheWrite12h: 200 }), model()).openRouterReferenceUsd,
    null,
  );
  assert.equal(
    estimateRequestCost(request({ cacheWrite: 200 }), model(), { cacheWriteTtl: "12h" }).status,
    "unsupported-tier",
  );
});

test("min_prompt_tokens context overrides apply at the exact API boundary, not to subscription reference", () => {
  const low = estimateRequestCost(request({ input: 271999 }), model());
  const edge = estimateRequestCost(request({ input: 272000 }), model());
  assert.ok(edge.openRouterReferenceUsd > low.openRouterReferenceUsd * 1.9);
  const subscription = estimateRequestCost(request({ input: 272000 }), model(), {
    billingContext: "codex-subscription-allowance",
    serviceTier: "standard",
  });
  assert.ok(subscription.openRouterReferenceUsd < edge.openRouterReferenceUsd);
  assert.equal(subscription.subscriptionAllowanceWeight, null);
});

test("missing cache price only prevents requests which actually use that category", () => {
  const m = model();
  m.pricing.input_cache_read = null;
  assert.equal(estimateRequestCost(request(), m).status, "missing-price");
  assert.equal(estimateRequestCost(request({ cached: 0 }), m).status, "priced");
});

test("explicit 12h API rate profiles price only that scenario, never pretend the catalog supplies 12h", () => {
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
  const result = estimateRequestCost(request({ cacheWrite: 100 }), model(), {
    billingContext: "openai-api",
    serviceTier: "fast",
    cacheWriteTtl: "12h",
    profile,
    now,
  });
  assert.equal(result.openRouterReferenceUsd, null);
  assert.equal(result.status, "priced");
  assert.ok(Math.abs(result.apiCostUsd - (500 * 4e-6 + 400 * 0.2e-6 + 100 * 10e-6 + 100 * 20e-6)) < 1e-12);
  assert.equal(estimateRequestCost(request(), model(), { billingContext: "invented" }).status, "unknown-mode");
});

test("cache uses validated 24h snapshot without network; forced refresh is anonymous and sanitized", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tui-price-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, "pricing", "openrouter-catalog.json");
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, "https://openrouter.ai/api/v1/models");
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, undefined);
    return { ok: true, json: async () => payload() };
  };
  assert.equal((await loadOpenRouterCatalog({ cacheFile, fetchImpl, now })).status, "fresh");
  assert.equal((await loadOpenRouterCatalog({ cacheFile, fetchImpl, now: now + 1000 })).status, "fresh");
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await fs.readFile(cacheFile, "utf8")).schemaVersion, 1);
});

for (const code of [401, 403, 429, 500, "timeout", "json", "shape"]) {
  test(`fetch ${code} preserves a stale validated cache and first failure is unavailable`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tui-price-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const cacheFile = path.join(dir, "catalog.json");
    const fetchImpl = async () => {
      if (code === "timeout") throw Object.assign(new Error("private url must not leak"), { name: "TimeoutError" });
      if (code === "json")
        return {
          ok: true,
          json: async () => {
            throw new Error("invalid JSON");
          },
        };
      if (code === "shape") return { ok: true, json: async () => ({}) };
      return { ok: false, status: code };
    };
    const first = await loadOpenRouterCatalog({ cacheFile, fetchImpl, now });
    assert.equal(first.status, "unavailable");
    assert.equal(first.catalog, null);
    assert.equal(JSON.stringify(first).includes("private url"), false);
    await fs.writeFile(cacheFile, JSON.stringify(catalog()));
    const previous = await fs.readFile(cacheFile, "utf8");
    const result = await loadOpenRouterCatalog({ cacheFile, fetchImpl, now: now + 25 * 3600_000 });
    assert.equal(result.status, "stale");
    assert.equal(await fs.readFile(cacheFile, "utf8"), previous);
    assert.equal(
      estimateRequestCost(request(), result.catalog.modelsById["openai/gpt-6.1-sol"], { pricingStatus: result.status })
        .status,
      "stale-price",
    );
  });
}

test("corrupt, future and foreign-source caches cannot be used as trusted snapshots", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tui-price-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, "catalog.json");
  for (const value of [
    "not json",
    JSON.stringify({ ...catalog(), sourceUrl: "https://evil.invalid" }),
    JSON.stringify({ ...catalog(), fetchedAt: new Date(now + 3600_000).toISOString() }),
  ]) {
    await fs.writeFile(cacheFile, value);
    assert.equal(
      (
        await loadOpenRouterCatalog({
          cacheFile,
          now,
          fetchImpl: async () => {
            throw new Error("offline");
          },
        })
      ).status,
      "unavailable",
    );
  }
});

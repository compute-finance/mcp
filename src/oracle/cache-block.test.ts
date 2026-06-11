/**
 * End-to-end check that the MCP consumes the Oracle's camelCase cache block
 * from /v1/oracle/pricing: pricingCacheBlock() → mergeCache() →
 * ModelPrice.cache → effectiveCost().
 *
 * The cache values below differ from the openai provider fallback (read 0.1),
 * so a regression where mergeCache fails to read the oracle block would fall
 * back to {read:0.1, source:'local-fallback'} and fail these assertions.
 *
 * Run with: npx tsx --test src/oracle/cache-block.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { getModelPrice, effectiveCost } from "./client.js";
import { initFieldMap, _resetFieldMap } from "./field-map.js";

const BASKET = {
  models: [
    {
      id: "gpt-5.5",
      displayName: "GPT-5.5",
      provider: { key: "openai", name: "OpenAI" },
      tier: "frontier",
      integrated: true,
      releasedAt: null,
      markedUpUsdPricePerMillion: { input: 1.25, output: 10 },
      markedUpWeiPricePerMillion: { input: 189, output: 1512 },
    },
  ],
};

// /v1/oracle/pricing — camelCase cache block. Distinct from fallbacks.
const PRICING = {
  object: "pricing",
  models: {
    "gpt-5.5": {
      input: { weiPerMillion: 189, usdPerMillion: 1.25 },
      output: { weiPerMillion: 1512, usdPerMillion: 10 },
      cache: { readMultiplier: 0.07, writeMultiplier5m: 1.3, writeMultiplier1h: 2.2 },
      source: "https://openai.com/api/pricing",
    },
  },
};

const realFetch = globalThis.fetch;
const mockRes = (data: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => data }) as Response;

describe("MCP cache-block consumption (camelCase wire)", () => {
  before(async () => {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/v1/oracle/basket")) return mockRes(BASKET);
      if (u.includes("/v1/oracle/pricing")) return mockRes(PRICING);
      return mockRes(null, false, 404); // openapi.json → field-map uses defaults
    }) as typeof fetch;
    _resetFieldMap();
    await initFieldMap();
  });

  after(() => {
    globalThis.fetch = realFetch;
    _resetFieldMap();
  });

  it("SHOULD resolve cache multipliers from the camelCase oracle block (not the provider fallback)", async () => {
    const price = await getModelPrice("gpt-5.5");
    assert.ok(price, "gpt-5.5 resolved from basket");
    assert.deepEqual(price!.cache, {
      read: 0.07,
      write_5m: 1.3,
      write_1h: 2.2,
      source: "oracle",
    });
  });

  it("SHOULD apply the oracle cache-read multiplier in effectiveCost", async () => {
    const price = await getModelPrice("gpt-5.5");
    const inPerTok = price!.input_usd_per_million / 1_000_000;
    const eff = effectiveCost(price!, 0, 1_000_000, 0, 0); // 1M cache-read tokens
    assert.equal(eff.breakdown.cache_read_usd, 1_000_000 * inPerTok * 0.07);
  });
});

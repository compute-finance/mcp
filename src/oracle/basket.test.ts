import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getBasketPrices, getCpi, _resetBasketCache } from "./client.js";
import { _resetFieldMap, _seedDefaultFieldMap } from "./field-map.js";

let originalFetch: typeof globalThis.fetch;

function mockBasket(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

function wireModel(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "qwen3.7-plus",
    displayName: "Qwen3.7 Plus",
    provider: { key: "alibaba", name: "Alibaba" },
    family: "alibaba.qwen-plus",
    weiPricePerMillion: { input: 10, output: 40 },
    usdPricePerMillion: { input: 0.4, output: 1.6 },
    markedUpWeiPricePerMillion: { input: 10.5, output: 42 },
    markedUpUsdPricePerMillion: { input: 0.42, output: 1.68 },
    releasedAt: "2026-06-01T00:00:00.000Z",
    cache: null,
    ...over,
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetBasketCache();
  _resetFieldMap();
  _seedDefaultFieldMap();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetFieldMap();
});

describe("getBasketPrices", () => {
  it("SHOULD read the base USD and wei prices, never the marked-up twins — Bug guarded: a basket model priced from markedUp* costs 5% more than the same provider price served from the catalog", async () => {
    mockBasket({ models: [wireModel()], routingFeeRate: 0.05 });
    const [m] = await getBasketPrices();
    assert.equal(m.base_input_usd_per_million, 0.4);
    assert.equal(m.base_output_usd_per_million, 1.6);
    assert.equal(m.base_input_wei_per_million, 10);
    assert.equal(m.base_output_wei_per_million, 40);
  });

  it("SHOULD derive a cache component from the base input price — Bug guarded: resolving a cache ratio against the marked-up input puts two pricing bases inside one model", async () => {
    mockBasket({
      models: [
        wireModel({
          cache: {
            cachedInput: {
              usdPerMillion: null,
              ratioOfInput: 0.1,
              source: "manual",
              sourceUrl: null,
              createdAt: "2026-07-21T07:58:42.658Z",
            },
            cacheWrite5m: null,
            cacheWrite1h: null,
          },
        }),
      ],
      routingFeeRate: 0.05,
    });
    const [m] = await getBasketPrices();
    assert.equal(m.cache?.cachedInput?.usdPerMillion, 0.04);
  });

  it("SHOULD issue one basket request FOR concurrent callers — Bug guarded: the model list and the routing fee are read in parallel, which doubles the request on a cold cache", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ models: [wireModel()], routingFeeRate: 0.05 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await Promise.all([getBasketPrices(), getCpi()]);
    assert.equal(calls, 1);
  });

  it("SHOULD keep a published cache price consistent with the base input price it is a ratio of", async () => {
    mockBasket({
      models: [
        wireModel({
          cache: {
            cachedInput: {
              usdPerMillion: 0.04,
              ratioOfInput: null,
              source: "manual",
              sourceUrl: null,
              createdAt: "2026-07-21T07:58:42.658Z",
            },
            cacheWrite5m: null,
            cacheWrite1h: null,
          },
        }),
      ],
      routingFeeRate: 0.05,
    });
    const [m] = await getBasketPrices();
    assert.equal(m.cache?.cachedInput?.ratioOfInput, 0.1);
  });
});

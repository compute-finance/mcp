import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModel,
  resolveModelPrice,
  resolvedToModelPrice,
  _resetBasketCache,
  _resetResolveCache,
  _seedBasketCache,
} from "./client.js";
import { _resetFieldMap, _seedDefaultFieldMap } from "./field-map.js";
import type { ModelPrice, ResolvedModel } from "./types.js";

let originalFetch: typeof globalThis.fetch;
let fetchCalls: string[] = [];

function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push(url);
    return handler(url);
  }) as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function resolveWire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputKey: "some-model",
    resolvedKey: "openai/some-model",
    family: "some.family",
    provider: { key: "openai", name: "OpenAI" },
    prices: {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 12,
      provenance: { input: "inferred", output: "inferred" },
    },
    cache: null,
    reasoning: null,
    inBasket: false,
    priceSource: "oracle-catalog",
    ...over,
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  _resetResolveCache();
  _resetBasketCache();
  _seedDefaultFieldMap();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetFieldMap();
});

describe("resolveModel", () => {
  it("SHOULD return null IF the input name is falsy", async () => {
    mockFetch(() => jsonResponse({}));
    assert.equal(await resolveModel(null), null);
    assert.equal(await resolveModel(undefined), null);
    assert.equal(await resolveModel(""), null);
    assert.equal(fetchCalls.length, 0);
  });

  it("SHOULD adapt a basket response into ResolvedModel WITH prices and cache", async () => {
    mockFetch(() =>
      jsonResponse({
        inputKey: "claude-opus-4-8",
        resolvedKey: "anthropic/claude-opus-4.8",
        family: "anthropic.claude-opus",
        provider: { key: "anthropic", name: "Anthropic" },
        prices: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
          provenance: { input: "verified", output: "verified" },
        },
        cache: {
          cachedInput: {
            usdPerMillion: 1.5,
            ratioOfInput: 0.1,
            provenance: "verified",
            createdAt: "2026-06-01T00:00:00Z",
          },
          cacheWrite5m: null,
          cacheWrite1h: null,
        },
        reasoning: null,
        inBasket: true,
        priceSource: "oracle-basket",
      }),
    );
    const r = await resolveModel("claude-opus-4-8");
    assert.ok(r !== null);
    assert.equal(r.resolved_key, "anthropic/claude-opus-4.8");
    assert.equal(r.input_key, "claude-opus-4-8");
    assert.equal(r.in_basket, true);
    assert.equal(r.price_source, "oracle-basket");
    assert.equal(r.base_input_usd_per_million, 15);
    assert.equal(r.base_output_usd_per_million, 75);
    assert.ok(r.cache !== null);
    assert.equal(r.cache.cachedInput?.usdPerMillion, 1.5);
  });

  it("SHOULD carry the base price provenance pair AND the reasoning component THROUGH adaptation", async () => {
    mockFetch(() =>
      jsonResponse(
        resolveWire({
          prices: {
            inputUsdPerMillion: 5,
            outputUsdPerMillion: 25,
            provenance: { input: "verified", output: "promotional" },
          },
          reasoning: {
            reasoningOutput: {
              usdPerMillion: 25,
              ratioOfInput: 5,
              provenance: "inferred",
              createdAt: null,
            },
          },
        }),
      ),
    );
    const r = await resolveModel("some-model");
    assert.ok(r !== null);
    assert.deepEqual(r.base_price_provenance, {
      input: "verified",
      output: "promotional",
    });
    assert.equal(r.reasoning?.reasoningOutput?.usdPerMillion, 25);
    assert.equal(r.reasoning?.reasoningOutput?.provenance, "inferred");
  });

  it("SHOULD keep reasoning null FOR a model the oracle publishes no reasoning price for", async () => {
    mockFetch(() => jsonResponse(resolveWire()));
    const r = await resolveModel("some-model");
    assert.equal(r?.reasoning, null);
  });

  it("SHOULD return ResolvedModel WITH null prices and null cache FOR an off-basket response", async () => {
    mockFetch(() =>
      jsonResponse({
        inputKey: "unknown-model",
        resolvedKey: "unknown-model",
        family: null,
        provider: null,
        prices: null,
        cache: null,
        reasoning: null,
        inBasket: false,
        priceSource: "off-basket",
      }),
    );
    const r = await resolveModel("unknown-model");
    assert.ok(r !== null);
    assert.equal(r.price_source, "off-basket");
    assert.equal(r.in_basket, false);
    assert.equal(r.base_input_usd_per_million, null);
    assert.equal(r.base_output_usd_per_million, null);
    assert.equal(r.base_price_provenance, null);
    assert.equal(r.cache, null);
  });

  it("SHOULD return null IF the request fails", async () => {
    mockFetch(() => new Response("oops", { status: 503 }));
    assert.equal(await resolveModel("any-model"), null);
  });

  it("SHOULD cache the result per-name FOR 60 seconds — Bug guarded: hot session repeatedly resolving the same model must not flood the oracle", async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return jsonResponse({
        inputKey: "anthropic/claude-opus-4.8",
        resolvedKey: "anthropic/claude-opus-4.8",
        family: "anthropic.claude-opus",
        provider: { key: "anthropic", name: "Anthropic" },
        prices: { inputUsdPerMillion: 15, outputUsdPerMillion: 75 },
        cache: null,
        inBasket: true,
        priceSource: "oracle-basket",
      });
    });
    await resolveModel("anthropic/claude-opus-4.8");
    await resolveModel("anthropic/claude-opus-4.8");
    await resolveModel("anthropic/claude-opus-4.8");
    assert.equal(calls, 1);
  });

  it("SHOULD use a separate cache entry PER distinct name", async () => {
    let calls = 0;
    mockFetch((url) => {
      calls += 1;
      const key = decodeURIComponent(url.split("/").pop()!);
      return jsonResponse({
        inputKey: key,
        resolvedKey: key,
        family: null,
        provider: null,
        prices: null,
        cache: null,
        inBasket: false,
        priceSource: "off-basket",
      });
    });
    await resolveModel("model-a");
    await resolveModel("model-b");
    await resolveModel("model-c");
    assert.equal(calls, 3);
  });

  it("SHOULD URL-encode the name segment — Bug guarded: a name with bracket annotations must not corrupt the URL path", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse({
        inputKey: "x",
        resolvedKey: "x",
        family: null,
        provider: null,
        prices: null,
        cache: null,
        inBasket: false,
        priceSource: "off-basket",
      });
    });
    await resolveModel("claude-opus-4.8[experimental]");
    assert.ok(
      capturedUrl.includes("claude-opus-4.8%5Bexperimental%5D"),
      `expected encoded brackets in URL; got: ${capturedUrl}`,
    );
  });
});

describe("resolveModelPrice", () => {
  function basketEntry(over: Partial<ModelPrice> = {}): ModelPrice {
    return {
      model: "anthropic/claude-opus-4.8",
      display_name: "Claude Opus 4.8",
      provider: "anthropic",
      provider_name: "Anthropic",
      family: "anthropic.claude-opus",
      released_at: null,
      base_input_usd_per_million: 15,
      base_output_usd_per_million: 75,
      base_input_wei_per_million: 15_000_000,
      base_output_wei_per_million: 75_000_000,
      cache: null,
      reasoning: null,
      ...over,
    };
  }

  it("SHOULD return null IF the oracle reports the model as off-basket", async () => {
    mockFetch(() =>
      jsonResponse(
        resolveWire({
          family: null,
          provider: null,
          prices: null,
          priceSource: "off-basket",
        }),
      ),
    );
    assert.equal(await resolveModelPrice("unknown-model"), null);
  });

  it("SHOULD return catalog-derived prices tagged as oracle-catalog FOR a non-basket model", async () => {
    mockFetch(() =>
      jsonResponse(
        resolveWire({
          inputKey: "gpt-x-preview",
          resolvedKey: "openai/gpt-x-preview",
          priceSource: "oracle-catalog",
          inBasket: false,
        }),
      ),
    );
    const priced = await resolveModelPrice("gpt-x-preview");
    assert.ok(priced !== null);
    assert.equal(priced.source, "oracle-catalog");
    assert.equal(priced.price.model, "openai/gpt-x-preview");
    assert.equal(priced.price.base_input_usd_per_million, 3);
    assert.equal(priced.price.base_output_usd_per_million, 12);
    assert.deepEqual(priced.base_price_provenance, {
      input: "inferred",
      output: "inferred",
    });
  });

  it("SHOULD return null IF the resolve request fails — Bug guarded: a 5xx must not surface as a fabricated zero-price entry", async () => {
    mockFetch(() => new Response("oops", { status: 503 }));
    assert.equal(await resolveModelPrice("anthropic/claude-opus-4.7"), null);
  });

  it("SHOULD enrich WITH the full basket entry (wei prices, display name) FOR an oracle-basket model", async () => {
    _seedBasketCache([basketEntry()]);
    mockFetch(() =>
      jsonResponse(
        resolveWire({
          inputKey: "claude-opus-4-8",
          resolvedKey: "anthropic/claude-opus-4.8",
          family: "anthropic.claude-opus",
          provider: { key: "anthropic", name: "Anthropic" },
          prices: {
            inputUsdPerMillion: 15,
            outputUsdPerMillion: 75,
            provenance: { input: "verified", output: "verified" },
          },
          inBasket: true,
          priceSource: "oracle-basket",
        }),
      ),
    );
    const priced = await resolveModelPrice("claude-opus-4-8");
    assert.ok(priced !== null);
    assert.equal(priced.source, "oracle-basket");
    assert.equal(priced.price.model, "anthropic/claude-opus-4.8");
    assert.equal(priced.price.display_name, "Claude Opus 4.8");
    assert.equal(priced.price.base_input_wei_per_million, 15_000_000);
    assert.equal(priced.price.base_output_wei_per_million, 75_000_000);
  });

  it("SHOULD leave the base price unmarked FOR a basket-sourced price — Bug guarded: the resolve response's catalogue mark describes a catalogue number, not the manifest figure the basket entry supplies", async () => {
    _seedBasketCache([basketEntry()]);
    mockFetch(() =>
      jsonResponse(
        resolveWire({
          resolvedKey: "anthropic/claude-opus-4.8",
          prices: {
            inputUsdPerMillion: 15,
            outputUsdPerMillion: 75,
            provenance: { input: "verified", output: "promotional" },
          },
          inBasket: true,
          priceSource: "oracle-basket",
        }),
      ),
    );
    const priced = await resolveModelPrice("claude-opus-4-8");
    assert.equal(priced?.price.base_input_wei_per_million, 15_000_000);
    assert.equal(priced?.base_price_provenance, null);
  });

  it("SHOULD fall back to resolvedToModelPrice WITH null wei IF the basket does not contain the resolved key — Bug guarded: an unpublished wei price must read as absent, not as a free model", async () => {
    _seedBasketCache([]);
    mockFetch(() =>
      jsonResponse(
        resolveWire({
          resolvedKey: "anthropic/claude-opus-4.8",
          inBasket: true,
          priceSource: "oracle-basket",
        }),
      ),
    );
    const priced = await resolveModelPrice("claude-opus-4-8");
    assert.ok(priced !== null);
    assert.equal(priced.source, "oracle-basket");
    assert.equal(priced.price.model, "anthropic/claude-opus-4.8");
    assert.equal(priced.price.base_input_wei_per_million, null);
    assert.deepEqual(priced.base_price_provenance, {
      input: "inferred",
      output: "inferred",
    });
  });
});

describe("resolveModelPrice — basket vs catalog parity", () => {
  const BASKET_WIRE = {
    routingFeeRate: 0.05,
    models: [
      {
        id: "anthropic/claude-opus-5",
        displayName: "Claude Opus 5",
        provider: { key: "anthropic", name: "Anthropic" },
        family: "anthropic.claude-opus",
        weiPricePerMillion: { input: 100, output: 500 },
        usdPricePerMillion: { input: 5, output: 25 },
        markedUpWeiPricePerMillion: { input: 105, output: 525 },
        markedUpUsdPricePerMillion: { input: 5.25, output: 26.25 },
        releasedAt: null,
        cache: null,
        reasoning: null,
      },
    ],
  };

  function serveBasketAndResolve(url: string): Response {
    if (url.includes("/v1/oracle/basket")) return jsonResponse(BASKET_WIRE);
    const key = decodeURIComponent(url.split("/").pop()!);
    const inBasket = key === "anthropic/claude-opus-5";
    return jsonResponse(
      resolveWire({
        inputKey: key,
        resolvedKey: key,
        family: "anthropic.claude-opus",
        provider: { key: "anthropic", name: "Anthropic" },
        prices: {
          inputUsdPerMillion: 5,
          outputUsdPerMillion: 25,
          provenance: { input: "inferred", output: "inferred" },
        },
        inBasket,
        priceSource: inBasket ? "oracle-basket" : "oracle-catalog",
      }),
    );
  }

  it("SHOULD return the provider list price FOR both a basket member and a catalog-only model that share it — Bug guarded: pricing a basket member from the marked-up field makes it 5% pricier than an identically priced catalog model", async () => {
    mockFetch(serveBasketAndResolve);
    const member = await resolveModelPrice("anthropic/claude-opus-5");
    const catalogOnly = await resolveModelPrice("anthropic/claude-opus-4.7");

    assert.ok(member !== null && catalogOnly !== null);
    assert.equal(member.source, "oracle-basket");
    assert.equal(catalogOnly.source, "oracle-catalog");
    assert.equal(member.price.base_input_usd_per_million, 5);
    assert.equal(member.price.base_output_usd_per_million, 25);
    assert.equal(
      member.price.base_input_usd_per_million,
      catalogOnly.price.base_input_usd_per_million,
    );
    assert.equal(
      member.price.base_output_usd_per_million,
      catalogOnly.price.base_output_usd_per_million,
    );
  });

  it("SHOULD still enrich the basket member WITH wei prices the catalog cannot supply", async () => {
    mockFetch(serveBasketAndResolve);
    const member = await resolveModelPrice("anthropic/claude-opus-5");
    const catalogOnly = await resolveModelPrice("anthropic/claude-opus-4.7");
    assert.equal(member!.price.base_input_wei_per_million, 100);
    assert.equal(catalogOnly!.price.base_input_wei_per_million, null);
  });
});

describe("resolvedToModelPrice", () => {
  function baseResolved(
    overrides: Partial<ResolvedModel> = {},
  ): ResolvedModel {
    return {
      input_key: "claude-opus-4.8",
      resolved_key: "anthropic/claude-opus-4.8",
      family: "anthropic.claude-opus",
      provider: { key: "anthropic", name: "Anthropic" },
      base_input_usd_per_million: 15,
      base_output_usd_per_million: 75,
      base_price_provenance: { input: "verified", output: "verified" },
      cache: null,
      reasoning: null,
      in_basket: true,
      price_source: "oracle-basket",
      ...overrides,
    };
  }

  it("SHOULD copy resolved_key INTO model field", () => {
    const r = baseResolved();
    const p = resolvedToModelPrice(r);
    assert.equal(p.model, r.resolved_key);
  });

  it("SHOULD coerce missing prices to zero FOR off-basket inputs", () => {
    const p = resolvedToModelPrice(
      baseResolved({ base_input_usd_per_million: null, base_output_usd_per_million: null }),
    );
    assert.equal(p.base_input_usd_per_million, 0);
    assert.equal(p.base_output_usd_per_million, 0);
  });

  it("SHOULD coerce null provider/family to empty strings", () => {
    const p = resolvedToModelPrice(
      baseResolved({ provider: null, family: null }),
    );
    assert.equal(p.provider, "");
    assert.equal(p.provider_name, "");
    assert.equal(p.family, "");
  });

  it("SHOULD carry the reasoning block ACROSS the conversion", () => {
    const reasoning = {
      reasoningOutput: {
        usdPerMillion: 75,
        ratioOfInput: 5,
        provenance: "inferred" as const,
        createdAt: null,
      },
    };
    assert.deepEqual(resolvedToModelPrice(baseResolved({ reasoning })).reasoning, reasoning);
  });
});

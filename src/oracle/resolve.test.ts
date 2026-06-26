import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModel,
  resolvedToModelPrice,
  _resetResolveCache,
} from "./client.js";
import type { ResolvedModel } from "./types.js";

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

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  _resetResolveCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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
        resolvedKey: "claude-opus-4.8",
        family: "anthropic.claude-opus",
        provider: { key: "anthropic", name: "Anthropic" },
        prices: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        cache: {
          cachedInput: {
            usdPerMillion: 1.5,
            ratioOfInput: 0.1,
            source: "test",
            sourceUrl: null,
            createdAt: "2026-06-01T00:00:00Z",
          },
          cacheWrite5m: null,
          cacheWrite1h: null,
        },
        inBasket: true,
        priceSource: "oracle-basket",
      }),
    );
    const r = await resolveModel("claude-opus-4-8");
    assert.ok(r !== null);
    assert.equal(r.resolved_key, "claude-opus-4.8");
    assert.equal(r.input_key, "claude-opus-4-8");
    assert.equal(r.in_basket, true);
    assert.equal(r.price_source, "oracle-basket");
    assert.equal(r.input_usd_per_million, 15);
    assert.equal(r.output_usd_per_million, 75);
    assert.ok(r.cache !== null);
    assert.equal(r.cache.cachedInput?.usdPerMillion, 1.5);
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
        inBasket: false,
        priceSource: "off-basket",
      }),
    );
    const r = await resolveModel("unknown-model");
    assert.ok(r !== null);
    assert.equal(r.price_source, "off-basket");
    assert.equal(r.in_basket, false);
    assert.equal(r.input_usd_per_million, null);
    assert.equal(r.output_usd_per_million, null);
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
        inputKey: "claude-opus-4.8",
        resolvedKey: "claude-opus-4.8",
        family: "anthropic.claude-opus",
        provider: { key: "anthropic", name: "Anthropic" },
        prices: { inputUsdPerMillion: 15, outputUsdPerMillion: 75 },
        cache: null,
        inBasket: true,
        priceSource: "oracle-basket",
      });
    });
    await resolveModel("claude-opus-4.8");
    await resolveModel("claude-opus-4.8");
    await resolveModel("claude-opus-4.8");
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

describe("resolvedToModelPrice", () => {
  function baseResolved(
    overrides: Partial<ResolvedModel> = {},
  ): ResolvedModel {
    return {
      input_key: "claude-opus-4.8",
      resolved_key: "claude-opus-4.8",
      family: "anthropic.claude-opus",
      provider: { key: "anthropic", name: "Anthropic" },
      input_usd_per_million: 15,
      output_usd_per_million: 75,
      cache: null,
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

  it("SHOULD copy in_basket INTO integrated", () => {
    assert.equal(resolvedToModelPrice(baseResolved({ in_basket: true })).integrated, true);
    assert.equal(resolvedToModelPrice(baseResolved({ in_basket: false })).integrated, false);
  });

  it("SHOULD coerce missing prices to zero FOR off-basket inputs", () => {
    const p = resolvedToModelPrice(
      baseResolved({ input_usd_per_million: null, output_usd_per_million: null }),
    );
    assert.equal(p.input_usd_per_million, 0);
    assert.equal(p.output_usd_per_million, 0);
  });

  it("SHOULD coerce null provider/family to empty strings", () => {
    const p = resolvedToModelPrice(
      baseResolved({ provider: null, family: null }),
    );
    assert.equal(p.provider, "");
    assert.equal(p.provider_name, "");
    assert.equal(p.family, "");
  });
});

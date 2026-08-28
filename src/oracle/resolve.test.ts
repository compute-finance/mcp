import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getIndexPrices,
  resolveModel,
  resolveModelPrice,
  resolvedToModelPrice,
  _resetOracleCache,
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
  _resetOracleCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetOracleCache();
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
    assert.deepEqual(priced.price.base_price_provenance, {
      input: "inferred",
      output: "inferred",
    });
  });

  it("SHOULD return null IF the resolve request fails — Bug guarded: a 5xx must not surface as a fabricated zero-price entry", async () => {
    mockFetch(() => new Response("oops", { status: 503 }));
    assert.equal(await resolveModelPrice("anthropic/claude-opus-4.7"), null);
  });

  it("SHOULD still price a model the catalogue does not list — Bug guarded: an unreadable catalogue must cost the model its display name, never its price", async () => {
    mockFetch((url) =>
      url.includes("/v1/oracle/catalog")
        ? new Response("oops", { status: 503 })
        : jsonResponse(
            resolveWire({
              resolvedKey: "anthropic/claude-opus-4.8",
              inBasket: true,
              priceSource: "oracle-basket",
            }),
          ),
    );
    const priced = await resolveModelPrice("claude-opus-4-8");
    assert.ok(priced !== null);
    assert.equal(priced.price.model, "anthropic/claude-opus-4.8");
    assert.equal(priced.price.display_name, "anthropic/claude-opus-4.8");
    assert.equal(priced.price.base_input_usd_per_million, 3);
  });
});

describe("resolveModelPrice — the snapshot and the catalogue disagree", () => {
  const MEMBER = "deepseek/deepseek-v4-pro";
  const CATALOG_ONLY = "deepseek/deepseek-v4-lite";
  const CATALOG_PRICES: Record<string, { input: number; output: number }> = {
    [MEMBER]: { input: 1.32, output: 3.96 },
    [CATALOG_ONLY]: { input: 1.32, output: 3.96 },
  };

  const STALE_SNAPSHOT_WIRE = {
    routingFeeRate: 0.05,
    models: [
      {
        id: MEMBER,
        displayName: "DeepSeek V4 Pro",
        provider: { key: "deepseek", name: "DeepSeek" },
        family: "deepseek.v-pro",
        weiPricePerMillion: { input: 100, output: 200 },
        usdPricePerMillion: { input: 0.435, output: 0.87 },
        markedUpUsdPricePerMillion: { input: 0.457, output: 0.914 },
        releasedAt: null,
        cache: null,
        reasoning: null,
      },
    ],
  };

  function catalogEntry(key: string, indexMember: boolean) {
    return {
      modelKey: key,
      displayName: indexMember ? "DeepSeek V4 Pro" : "DeepSeek V4 Lite",
      provider: { key: "deepseek", name: "DeepSeek" },
      family: indexMember ? "deepseek.v-pro" : "deepseek.v-lite",
      indexMember,
      releasedAt: "2026-05-01T00:00:00.000Z",
      currentPrice: {
        inputPriceUsdPerMillion: CATALOG_PRICES[key].input,
        outputPriceUsdPerMillion: CATALOG_PRICES[key].output,
        provenance: { input: "verified", output: "verified" },
      },
      cache: null,
      reasoning: null,
    };
  }

  function serveDisagreeingOracle(url: string): Response {
    if (url.includes("/v1/oracle/basket")) return jsonResponse(STALE_SNAPSHOT_WIRE);
    if (url.includes("/v1/oracle/catalog")) {
      return jsonResponse({
        models: [catalogEntry(MEMBER, true), catalogEntry(CATALOG_ONLY, false)],
      });
    }
    const key = decodeURIComponent(url.split("/").pop()!);
    return jsonResponse(
      resolveWire({
        inputKey: key,
        resolvedKey: key,
        family: "deepseek.v-pro",
        provider: { key: "deepseek", name: "DeepSeek" },
        prices: {
          inputUsdPerMillion: CATALOG_PRICES[key].input,
          outputUsdPerMillion: CATALOG_PRICES[key].output,
          provenance: { input: "verified", output: "verified" },
        },
        inBasket: key === MEMBER,
        priceSource: key === MEMBER ? "oracle-basket" : "oracle-catalog",
      }),
    );
  }

  it("SHOULD quote an index member at the catalogue price, not the attested one — Bug guarded: a snapshot-sourced quote understates deepseek-v4-pro threefold for as long as an operator holds back the next revision", async () => {
    mockFetch(serveDisagreeingOracle);
    const priced = await resolveModelPrice(MEMBER);
    assert.ok(priced !== null);
    assert.equal(priced.source, "oracle-basket");
    assert.equal(priced.price.base_input_usd_per_million, 1.32);
    assert.equal(priced.price.base_output_usd_per_million, 3.96);
  });

  it("SHOULD list the index member at the catalogue price — Bug guarded: the index listing and the single-model quote must not disagree about what one model costs", async () => {
    mockFetch(serveDisagreeingOracle);
    const [listed] = await getIndexPrices();
    assert.equal(listed.model, MEMBER);
    assert.equal(listed.base_input_usd_per_million, 1.32);
    assert.equal(listed.base_output_usd_per_million, 3.96);
  });

  it("SHOULD return identical prices FOR an index member and a catalog-only model sharing a provider price — Bug guarded: index membership must not move a model's price", async () => {
    mockFetch(serveDisagreeingOracle);
    const member = await resolveModelPrice(MEMBER);
    const catalogOnly = await resolveModelPrice(CATALOG_ONLY);
    assert.ok(member !== null && catalogOnly !== null);
    assert.equal(member.source, "oracle-basket");
    assert.equal(catalogOnly.source, "oracle-catalog");
    assert.equal(
      member.price.base_input_usd_per_million,
      catalogOnly.price.base_input_usd_per_million,
    );
    assert.equal(
      member.price.base_output_usd_per_million,
      catalogOnly.price.base_output_usd_per_million,
    );
  });

  it("SHOULD name both models from the catalogue — Bug guarded: a display name served only to index members is the same membership asymmetry in another field", async () => {
    mockFetch(serveDisagreeingOracle);
    const member = await resolveModelPrice(MEMBER);
    const catalogOnly = await resolveModelPrice(CATALOG_ONLY);
    assert.equal(member?.price.display_name, "DeepSeek V4 Pro");
    assert.equal(catalogOnly?.price.display_name, "DeepSeek V4 Lite");
    assert.equal(member?.price.released_at, "2026-05-01T00:00:00.000Z");
    assert.equal(catalogOnly?.price.released_at, "2026-05-01T00:00:00.000Z");
  });

  it("SHOULD never read the attested snapshot to answer a price — Bug guarded: any request to it is a second pricing basis waiting to diverge", async () => {
    mockFetch(serveDisagreeingOracle);
    await resolveModelPrice(MEMBER);
    await getIndexPrices();
    assert.deepEqual(
      fetchCalls.filter((u) => u.includes("/v1/oracle/basket")),
      [],
    );
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

  it("SHOULD carry the base price provenance pair ACROSS the conversion", () => {
    const p = resolvedToModelPrice(baseResolved());
    assert.deepEqual(p.base_price_provenance, {
      input: "verified",
      output: "verified",
    });
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

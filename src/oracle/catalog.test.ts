import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCatalog,
  getCatalogPrices,
  getIndexPrices,
  _resetOracleCache,
} from "./client.js";

let originalFetch: typeof globalThis.fetch;

function mockCatalog(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

function wireModel(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelKey: "qwen/qwen3.7-plus",
    displayName: "Qwen3.7 Plus",
    provider: { key: "alibaba", name: "Alibaba" },
    family: "alibaba.qwen-plus",
    indexMember: true,
    releasedAt: "2026-06-01T00:00:00.000Z",
    currentPrice: {
      inputPriceUsdPerMillion: 0.4,
      outputPriceUsdPerMillion: 1.6,
      provenance: { input: "verified", output: "verified" },
      observedAt: "2026-08-26T15:16:27.956Z",
    },
    cache: null,
    reasoning: null,
    ...over,
  };
}

function wireComponent(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    usdPerMillion: null,
    ratioOfInput: 0.1,
    provenance: "inferred",
    createdAt: "2026-07-21T07:58:42.658Z",
    ...over,
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetOracleCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetOracleCache();
});

describe("getCatalogPrices", () => {
  it("SHOULD read the price the catalogue currently publishes", async () => {
    mockCatalog({ models: [wireModel()] });
    const [m] = await getCatalogPrices();
    assert.equal(m.model, "qwen/qwen3.7-plus");
    assert.equal(m.display_name, "Qwen3.7 Plus");
    assert.equal(m.provider, "alibaba");
    assert.equal(m.provider_name, "Alibaba");
    assert.equal(m.family, "alibaba.qwen-plus");
    assert.equal(m.released_at, "2026-06-01T00:00:00.000Z");
    assert.equal(m.base_input_usd_per_million, 0.4);
    assert.equal(m.base_output_usd_per_million, 1.6);
  });

  it("SHOULD carry the base price provenance pair ONTO every model — Bug guarded: a catalogue price always ships marked, so a null pair would tell an agent the number came from somewhere else", async () => {
    mockCatalog({
      models: [
        wireModel({
          currentPrice: {
            inputPriceUsdPerMillion: 4,
            outputPriceUsdPerMillion: 20,
            provenance: { input: "promotional", output: "verified" },
          },
        }),
      ],
    });
    const [m] = await getCatalogPrices();
    assert.deepEqual(m.base_price_provenance, {
      input: "promotional",
      output: "verified",
    });
  });

  it("SHOULD list index members and non-members alike", async () => {
    mockCatalog({
      models: [
        wireModel(),
        wireModel({ modelKey: "qwen/qwen-3.5-plus", indexMember: false }),
      ],
    });
    assert.deepEqual(
      (await getCatalogPrices()).map((m) => m.model),
      ["qwen/qwen3.7-plus", "qwen/qwen-3.5-plus"],
    );
  });

  it("SHOULD skip a model the catalogue publishes no current price for — Bug guarded: an unpriced row must not read as a free model", async () => {
    mockCatalog({
      models: [wireModel({ currentPrice: null }), wireModel({ modelKey: "a/b" })],
    });
    assert.deepEqual(
      (await getCatalogPrices()).map((m) => m.model),
      ["a/b"],
    );
  });

  it("SHOULD derive a cache component from the base input price", async () => {
    mockCatalog({
      models: [
        wireModel({
          cache: {
            cachedInput: wireComponent(),
            cacheWrite5m: null,
            cacheWrite1h: null,
          },
        }),
      ],
    });
    const [m] = await getCatalogPrices();
    assert.equal(m.cache?.cachedInput?.usdPerMillion, 0.04);
  });

  it("SHOULD keep a published cache price consistent with the base input price it is a ratio of", async () => {
    mockCatalog({
      models: [
        wireModel({
          cache: {
            cachedInput: wireComponent({ usdPerMillion: 0.04, ratioOfInput: null }),
            cacheWrite5m: null,
            cacheWrite1h: null,
          },
        }),
      ],
    });
    const [m] = await getCatalogPrices();
    assert.equal(m.cache?.cachedInput?.ratioOfInput, 0.1);
  });

  it("SHOULD carry the provenance mark ONTO every adapted cache component — Bug guarded: dropping the mark leaves a consumer unable to tell a sourced price from a guessed one", async () => {
    mockCatalog({
      models: [
        wireModel({
          cache: {
            cachedInput: wireComponent({ provenance: "verified" }),
            cacheWrite5m: wireComponent({ ratioOfInput: 1.25, provenance: "promotional" }),
            cacheWrite1h: null,
          },
        }),
      ],
    });
    const [m] = await getCatalogPrices();
    assert.equal(m.cache?.cachedInput?.provenance, "verified");
    assert.equal(m.cache?.cacheWrite5m?.provenance, "promotional");
  });

  it("SHOULD expose the reasoning output price priced off the base input", async () => {
    mockCatalog({
      models: [
        wireModel({
          reasoning: { reasoningOutput: wireComponent({ ratioOfInput: 5 }) },
        }),
      ],
    });
    const [m] = await getCatalogPrices();
    assert.equal(m.reasoning?.reasoningOutput?.usdPerMillion, 2);
    assert.equal(m.reasoning?.reasoningOutput?.provenance, "inferred");
  });

  it("SHOULD keep reasoning null FOR a model the oracle publishes no reasoning price for", async () => {
    mockCatalog({ models: [wireModel()] });
    const [m] = await getCatalogPrices();
    assert.equal(m.reasoning, null);
  });

  it("SHOULD issue one catalogue request FOR concurrent callers — Bug guarded: prices and context ladders are read in parallel off the same document, which doubles the request on a cold cache", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ models: [wireModel()] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    await Promise.all([getIndexPrices(), getCatalogPrices(), getCatalog()]);
    assert.equal(calls, 1);
  });
});

describe("getIndexPrices", () => {
  it("SHOULD list exactly the models the catalogue flags as index members", async () => {
    mockCatalog({
      models: [
        wireModel({ modelKey: "a/member", indexMember: true }),
        wireModel({ modelKey: "a/non-member", indexMember: false }),
        wireModel({ modelKey: "a/unflagged", indexMember: undefined }),
      ],
    });
    assert.deepEqual(
      (await getIndexPrices()).map((m) => m.model),
      ["a/member"],
    );
  });

  it("SHOULD price an index member exactly as the catalogue prices it — Bug guarded: sourcing index members from the attested snapshot quotes a price the exchange stops billing the moment an operator corrects the catalogue", async () => {
    mockCatalog({
      models: [
        wireModel({
          modelKey: "deepseek/deepseek-v4-pro",
          indexMember: true,
          currentPrice: {
            inputPriceUsdPerMillion: 1.32,
            outputPriceUsdPerMillion: 3.96,
            provenance: { input: "verified", output: "verified" },
          },
        }),
      ],
    });
    const [m] = await getIndexPrices();
    assert.equal(m.base_input_usd_per_million, 1.32);
    assert.equal(m.base_output_usd_per_million, 3.96);
  });
});

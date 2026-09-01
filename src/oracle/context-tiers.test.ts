import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  contextFor,
  getCatalogContexts,
  modelContext,
  quoteAtContextTier,
  requireContextFor,
  selectContextTier,
  tryCatalogContexts,
  type CatalogContext,
} from "./context-tiers.js";
import { _resetOracleCache } from "./client.js";
import type { ContextTier, MarkedBaseRates } from "./types.js";

const FLAT: MarkedBaseRates = {
  base_input_usd_per_million: 1,
  base_output_usd_per_million: 5,
  base_price_provenance: null,
};

function catalogContext(over: Partial<CatalogContext> = {}): CatalogContext {
  return { tiers: [], maxInputTokens: null, ...over };
}

function wireTier(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fromInputTokens: 2000,
    inputPriceUsdPerMillion: 2,
    outputPriceUsdPerMillion: 10,
    provenance: "verified",
    ...over,
  };
}

let originalFetch: typeof globalThis.fetch;

function mockCatalog(body: unknown): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { calls: () => calls };
}

function mockCatalogOutage(): void {
  globalThis.fetch = (async () =>
    new Response("upstream unavailable", { status: 503 })) as typeof globalThis.fetch;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const original = process.stderr.write;
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetOracleCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("modelContext", () => {
  it("SHOULD give a flat model one rung starting at zero — Bug guarded: a model the catalogue lists with no rungs must not force the caller to branch on whether a model happens to be tiered", () => {
    const { context_tiers } = modelContext(FLAT, catalogContext(), 0.05);
    assert.equal(context_tiers.length, 1);
    assert.equal(context_tiers[0].from_input_tokens, 0);
    assert.equal(context_tiers[0].base_input_usd_per_million, 1);
    assert.equal(context_tiers[0].base_output_usd_per_million, 5);
  });

  it("SHOULD stack the catalogue rungs above the flat rate", () => {
    const { context_tiers } = modelContext(
      FLAT,
      catalogContext({
        tiers: [
          {
            fromInputTokens: 2000,
            inputPriceUsdPerMillion: 2,
            outputPriceUsdPerMillion: 10,
            provenance: "verified",
          },
        ],
      }),
      0.05,
    );
    assert.deepEqual(
      context_tiers.map((t) => [t.from_input_tokens, t.base_input_usd_per_million]),
      [
        [0, 1],
        [2000, 2],
      ],
    );
  });

  it("SHOULD price every rung on both bases — Bug guarded: a rung quoted on the base basis alone lets an agent budget a long context without the routing fee", () => {
    const { context_tiers } = modelContext(
      FLAT,
      catalogContext({
        tiers: [
          {
            fromInputTokens: 2000,
            inputPriceUsdPerMillion: 2,
            outputPriceUsdPerMillion: 10,
            provenance: "verified",
          },
        ],
      }),
      0.05,
    );
    assert.equal(context_tiers[1].billed_input_usd_per_million, 2.1);
    assert.equal(context_tiers[1].billed_output_usd_per_million, 10.5);
  });

  it("SHOULD null a rung's billed price IF the routing fee rate is unknown — Bug guarded: falling through to the base rate would present an unknown fee as no fee", () => {
    const { context_tiers } = modelContext(FLAT, catalogContext(), null);
    assert.equal(context_tiers[0].billed_input_usd_per_million, null);
    assert.equal(context_tiers[0].billed_output_usd_per_million, null);
  });

  it("SHOULD fan a rung's single mark out across both directions — Bug guarded: the vendor quotes a rung as one line, and collapsing the pair instead would drop the flat rate's asymmetric marks", () => {
    const { context_tiers } = modelContext(
      { ...FLAT, base_price_provenance: { input: "promotional", output: "inferred" } },
      catalogContext({
        tiers: [
          {
            fromInputTokens: 2000,
            inputPriceUsdPerMillion: 2,
            outputPriceUsdPerMillion: 10,
            provenance: "verified",
          },
        ],
      }),
      0.05,
    );
    assert.deepEqual(context_tiers[0].provenance, {
      input: "promotional",
      output: "inferred",
    });
    assert.deepEqual(context_tiers[1].provenance, {
      input: "verified",
      output: "verified",
    });
  });

  it("SHOULD report the ceiling the model declares, and null when it declares none", () => {
    assert.equal(modelContext(FLAT, catalogContext(), 0.05).max_input_tokens, null);
    assert.equal(
      modelContext(FLAT, catalogContext({ maxInputTokens: 5000 }), 0.05)
        .max_input_tokens,
      5000,
    );
  });
});

describe("selectContextTier", () => {
  const ladder = modelContext(
    FLAT,
    catalogContext({
      tiers: [
        {
          fromInputTokens: 2000,
          inputPriceUsdPerMillion: 2,
          outputPriceUsdPerMillion: 10,
          provenance: "verified",
        },
        {
          fromInputTokens: 200_000,
          inputPriceUsdPerMillion: 4,
          outputPriceUsdPerMillion: 20,
          provenance: "inferred",
        },
      ],
    }),
    0.05,
  ).context_tiers;

  function pick(inputTokens: number): ContextTier {
    return selectContextTier(ladder, inputTokens);
  }

  it("SHOULD take the rung an input lands exactly on — Bug guarded: half-open ranges mean 2000 tokens bills at the 2000 rung, not the one below", () => {
    assert.equal(pick(2000).from_input_tokens, 2000);
    assert.equal(pick(200_000).from_input_tokens, 200_000);
  });

  it("SHOULD stay one rung down one token below a threshold", () => {
    assert.equal(pick(1999).from_input_tokens, 0);
    assert.equal(pick(199_999).from_input_tokens, 2000);
  });

  it("SHOULD hold the last rung above the top threshold", () => {
    assert.equal(pick(50_000_000).from_input_tokens, 200_000);
  });

  it("SHOULD charge the flat rate below the first threshold, including an empty input", () => {
    assert.equal(pick(0).from_input_tokens, 0);
    assert.equal(pick(1).base_input_usd_per_million, 1);
  });

  it("SHOULD return the single rung FOR a flat model at any input size", () => {
    const flat = modelContext(FLAT, catalogContext(), 0.05).context_tiers;
    assert.equal(selectContextTier(flat, 0).from_input_tokens, 0);
    assert.equal(selectContextTier(flat, 10_000_000).base_input_usd_per_million, 1);
  });
});

describe("quoteAtContextTier", () => {
  const tiered = catalogContext({
    tiers: [
      {
        fromInputTokens: 2000,
        inputPriceUsdPerMillion: 2,
        outputPriceUsdPerMillion: 10,
        provenance: "verified",
      },
    ],
    maxInputTokens: 5000,
  });

  it("SHOULD move the quoted cost onto the rung the input selects AND name that rung — Bug guarded: pricing a long context at the flat rate is the whole defect the ladder exists to close", () => {
    const below = quoteAtContextTier(FLAT, tiered, 0.05, 1999, 1000);
    const at = quoteAtContextTier(FLAT, tiered, 0.05, 2000, 1000);
    assert.equal(below.applied_context_tier.from_input_tokens, 0);
    assert.equal(below.base_usd_cost, 0.006999);
    assert.equal(at.applied_context_tier.from_input_tokens, 2000);
    assert.equal(at.base_usd_cost, 0.014);
  });

  it("SHOULD flag the ceiling one token above it AND still quote the cost — Bug guarded: the ceiling is the largest input the model accepts, not the first it refuses, and a refused request is still worth pricing", () => {
    const at = quoteAtContextTier(FLAT, tiered, 0.05, 5000, 1000);
    const above = quoteAtContextTier(FLAT, tiered, 0.05, 5001, 1000);
    assert.equal(at.exceeds_max_input_tokens, false);
    assert.equal(above.exceeds_max_input_tokens, true);
    assert.equal(above.max_input_tokens, 5000);
    assert.ok(above.base_usd_cost > 0);
  });

  it("SHOULD never flag a model that declares no ceiling", () => {
    const quote = quoteAtContextTier(FLAT, catalogContext(), 0.05, 50_000_000, 0);
    assert.equal(quote.max_input_tokens, null);
    assert.equal(quote.exceeds_max_input_tokens, false);
  });
});

describe("getCatalogContexts", () => {
  it("SHOULD index every catalogue model by its canonical id in one request — Bug guarded: reading the ladder per model turns a whole-basket comparison into N catalogue fetches", async () => {
    const catalog = mockCatalog({
      models: [
        { modelKey: "anthropic/claude-haiku-4.5", contextTiers: [wireTier()] },
        { modelKey: "openai/gpt-5.4-nano", maxInputTokens: 5000 },
        { modelKey: "openai/gpt-5.5" },
      ],
    });
    const contexts = await getCatalogContexts();
    assert.equal(catalog.calls(), 1);
    assert.equal(contexts.size, 3);
    assert.equal(contexts.get("anthropic/claude-haiku-4.5")?.tiers.length, 1);
    assert.equal(contexts.get("openai/gpt-5.4-nano")?.maxInputTokens, 5000);
    assert.deepEqual(contexts.get("openai/gpt-5.5"), { tiers: [], maxInputTokens: null });
  });

  it("SHOULD sort rungs ascending — Bug guarded: selection walks the ladder in order, so an out-of-order rung would be quoted at the wrong input size", async () => {
    mockCatalog({
      models: [
        {
          modelKey: "unsorted",
          contextTiers: [
            wireTier({ fromInputTokens: 200_000 }),
            wireTier({ fromInputTokens: 2000 }),
          ],
        },
      ],
    });
    const contexts = await getCatalogContexts();
    assert.deepEqual(
      contexts.get("unsorted")?.tiers.map((t) => t.fromInputTokens),
      [2000, 200_000],
    );
  });

  it("SHOULD drop an unusable rung AND report the drift — Bug guarded: a silently dropped rung under-quotes a long context with no trace", async () => {
    mockCatalog({
      models: [
        {
          modelKey: "half-broken",
          contextTiers: [wireTier(), wireTier({ inputPriceUsdPerMillion: "2" })],
        },
      ],
    });
    const stderr = captureStderr();
    try {
      const contexts = await getCatalogContexts();
      assert.equal(contexts.get("half-broken")?.tiers.length, 1);
      assert.match(stderr.text(), /half-broken/);
    } finally {
      stderr.restore();
    }
  });

  it("SHOULD drop a rung published at zero — Bug guarded: a second rung at 0 wins selection over the synthesised flat rung and would shadow the attested flat rate at every input size", async () => {
    mockCatalog({
      models: [
        {
          modelKey: "zero-rung",
          contextTiers: [wireTier({ fromInputTokens: 0, inputPriceUsdPerMillion: 99 })],
        },
      ],
    });
    const stderr = captureStderr();
    try {
      const contexts = await getCatalogContexts();
      const ladder = modelContext(
        FLAT,
        requireContextFor(contexts, "zero-rung"),
        0.05,
      ).context_tiers;
      assert.equal(ladder.length, 1);
      assert.equal(selectContextTier(ladder, 0).base_input_usd_per_million, 1);
      assert.match(stderr.text(), /zero-rung/);
    } finally {
      stderr.restore();
    }
  });

  it("SHOULD drop a rung published below zero — Bug guarded: a negative threshold sorts under the flat rung and breaks the ascending order every caller reads the ladder in", async () => {
    mockCatalog({
      models: [
        {
          modelKey: "negative-rung",
          contextTiers: [wireTier({ fromInputTokens: -2000 }), wireTier()],
        },
      ],
    });
    const stderr = captureStderr();
    try {
      const contexts = await getCatalogContexts();
      const ladder = modelContext(
        FLAT,
        requireContextFor(contexts, "negative-rung"),
        0.05,
      ).context_tiers;
      assert.deepEqual(
        ladder.map((t) => t.from_input_tokens),
        [0, 2000],
      );
    } finally {
      stderr.restore();
    }
  });

  it("SHOULD keep only the first of two rungs sharing a threshold AND report the drift — Bug guarded: the ladder must stay strictly ascending, or which of the two prices a request is quoted at comes down to published order", async () => {
    mockCatalog({
      models: [
        {
          modelKey: "twin-rung",
          contextTiers: [wireTier(), wireTier({ inputPriceUsdPerMillion: 99 })],
        },
      ],
    });
    const stderr = captureStderr();
    try {
      const contexts = await getCatalogContexts();
      const ladder = modelContext(
        FLAT,
        requireContextFor(contexts, "twin-rung"),
        0.05,
      ).context_tiers;
      assert.deepEqual(
        ladder.map((t) => [t.from_input_tokens, t.base_input_usd_per_million]),
        [
          [0, 1],
          [2000, 2],
        ],
      );
      assert.match(stderr.text(), /twin-rung/);
    } finally {
      stderr.restore();
    }
  });

  it("SHOULD hold a rung threshold to the same positive-integer rule as the ceiling", async () => {
    mockCatalog({
      models: [
        { modelKey: "fraction", contextTiers: [wireTier({ fromInputTokens: 2000.5 })] },
        { modelKey: "text", contextTiers: [wireTier({ fromInputTokens: "2000" })] },
      ],
    });
    const stderr = captureStderr();
    try {
      const contexts = await getCatalogContexts();
      for (const key of ["fraction", "text"]) {
        assert.deepEqual(contexts.get(key)?.tiers, [], `${key} kept a bad threshold`);
      }
    } finally {
      stderr.restore();
    }
  });

  it("SHOULD reject a rung marked with something the oracle does not publish", async () => {
    mockCatalog({
      models: [{ modelKey: "odd-mark", contextTiers: [wireTier({ provenance: "guessed" })] }],
    });
    const stderr = captureStderr();
    try {
      assert.deepEqual((await getCatalogContexts()).get("odd-mark")?.tiers, []);
    } finally {
      stderr.restore();
    }
  });

  it("SHOULD ignore a maxInputTokens that is not a positive integer", async () => {
    mockCatalog({
      models: [
        { modelKey: "a", maxInputTokens: 0 },
        { modelKey: "b", maxInputTokens: "5000" },
        { modelKey: "c", maxInputTokens: 5000.5 },
      ],
    });
    const contexts = await getCatalogContexts();
    for (const key of ["a", "b", "c"]) {
      assert.equal(contexts.get(key)?.maxInputTokens, null, `${key} kept a bad ceiling`);
    }
  });

  it("SHOULD survive a catalogue with no models array", async () => {
    mockCatalog({ generatedAt: "2026-08-21T00:00:00Z" });
    assert.equal((await getCatalogContexts()).size, 0);
  });

  it("SHOULD fail the strict read AND report unknown on the soft read WHEN the catalogue is unreachable — Bug guarded: a quote must refuse rather than fall back to the flat rate, while a price list must not lose its base prices to an auxiliary endpoint", async () => {
    mockCatalogOutage();
    await assert.rejects(getCatalogContexts(), /catalog/);
    assert.equal(await tryCatalogContexts(), null);
  });
});

describe("contextFor", () => {
  it("SHOULD report a model the catalogue does not list as unknown AND flag the drift — Bug guarded: a synthesised one-rung ladder for an unlisted model is indistinguishable from a genuinely flat one", async () => {
    mockCatalog({ models: [{ modelKey: "listed" }] });
    const stderr = captureStderr();
    try {
      const contexts = await getCatalogContexts();
      assert.deepEqual(contextFor(contexts, "listed"), { tiers: [], maxInputTokens: null });
      assert.equal(contextFor(contexts, "unlisted"), null);
      assert.match(stderr.text(), /unlisted/);
    } finally {
      stderr.restore();
    }
  });

  it("SHOULD stay silent WHEN the catalogue could not be read at all — Bug guarded: one outage is one unknown, not a drift report against every model in the basket", () => {
    const stderr = captureStderr();
    try {
      assert.equal(contextFor(null, "any-model"), null);
      assert.equal(stderr.text(), "");
    } finally {
      stderr.restore();
    }
  });
});

describe("requireContextFor", () => {
  it("SHOULD refuse a model the catalogue does not list — Bug guarded: quoting it at the flat rate would understate exactly the long context the ladder exists to price", async () => {
    mockCatalog({ models: [{ modelKey: "listed", maxInputTokens: 5000 }] });
    const contexts = await getCatalogContexts();
    assert.throws(() => requireContextFor(contexts, "missing-model"), /missing-model/);
    assert.equal(requireContextFor(contexts, "listed").maxInputTokens, 5000);
  });
});

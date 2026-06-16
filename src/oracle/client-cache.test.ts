import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveCost,
  nominalCost,
  priceSession,
  OracleCachePricingMissingError,
  _internals,
} from "./client.js";
import type { CachePriceComponent, CachePricing, ModelPrice } from "./types.js";

const { adaptComponent, adaptCache } = _internals;

function component(over: Partial<CachePriceComponent> = {}): CachePriceComponent {
  return {
    usdPerMillion: 0.5,
    ratioOfInput: 0.1,
    source: "anthropic-pricing",
    sourceUrl: "https://www.anthropic.com/pricing",
    createdAt: "2026-06-16T00:00:00.000Z",
    ...over,
  };
}

function priceWithCache(cache: CachePricing | null): ModelPrice {
  return {
    model: "claude-test-1.0",
    display_name: "Claude Test 1.0",
    provider: "anthropic",
    provider_name: "Anthropic",
    family: "anthropic.claude",
    integrated: true,
    released_at: null,
    input_usd_per_million: 5,
    output_usd_per_million: 25,
    input_wei_per_million: 0,
    output_wei_per_million: 0,
    cache,
  };
}

describe("nominalCost", () => {
  it("sums input+cacheRead+cacheCreate at input rate plus output at output rate", () => {
    const price = priceWithCache(null);
    const usd = nominalCost(price, 1_000_000, 500_000, 500_000, 200_000);
    // (1M + 500k + 500k) * 5/M = 10; 200k * 25/M = 5; total 15
    assert.equal(usd, 15);
  });

  it("returns 0 when all token counts are 0", () => {
    assert.equal(nominalCost(priceWithCache(null), 0, 0, 0, 0), 0);
  });
});

describe("effectiveCost — cache pricing absent", () => {
  it("SHOULD throw block-missing IF cache=null and cacheRead>0", () => {
    const price = priceWithCache(null);
    assert.throws(
      () => effectiveCost(price, 0, 100, 0, 0),
      (err) =>
        err instanceof OracleCachePricingMissingError &&
        err.missing === "block" &&
        err.model === "claude-test-1.0",
    );
  });

  it("SHOULD throw block-missing IF cache=null and cacheCreate>0", () => {
    const price = priceWithCache(null);
    assert.throws(
      () => effectiveCost(price, 0, 0, 100, 0),
      (err) =>
        err instanceof OracleCachePricingMissingError && err.missing === "block",
    );
  });

  it("SHOULD NOT throw IF cache=null and no cache tokens", () => {
    const price = priceWithCache(null);
    const eff = effectiveCost(price, 1000, 0, 0, 100);
    assert.equal(eff.effective_usd, eff.nominal_usd);
    assert.equal(eff.cache_attribution, null);
    assert.match(eff.notes[0], /Cache pricing unavailable/);
  });
});

describe("effectiveCost — partial cache pricing", () => {
  it("SHOULD throw cachedInput-missing IF cachedInput=null and cacheRead>0", () => {
    const cache: CachePricing = {
      cachedInput: null,
      cacheWrite5m: component(),
      cacheWrite1h: component(),
    };
    const price = priceWithCache(cache);
    assert.throws(
      () => effectiveCost(price, 0, 100, 0, 0),
      (err) =>
        err instanceof OracleCachePricingMissingError &&
        err.missing === "cachedInput",
    );
  });

  it("SHOULD throw cacheWrite5m-missing IF cacheWrite5m=null and cacheCreate>0", () => {
    const cache: CachePricing = {
      cachedInput: component(),
      cacheWrite5m: null,
      cacheWrite1h: component(),
    };
    const price = priceWithCache(cache);
    assert.throws(
      () => effectiveCost(price, 0, 0, 100, 0),
      (err) =>
        err instanceof OracleCachePricingMissingError &&
        err.missing === "cacheWrite5m",
    );
  });

  it("SHOULD compute effective IF only cacheRead used and only cachedInput published", () => {
    const cache: CachePricing = {
      cachedInput: component({ usdPerMillion: 0.5, ratioOfInput: 0.1 }),
      cacheWrite5m: null,
      cacheWrite1h: null,
    };
    const price = priceWithCache(cache);
    const eff = effectiveCost(price, 1000, 1000, 0, 100);
    // raw 1000 * 5e-6 = 0.005; cacheRead 1000 * 0.5e-6 = 0.0005; output 100 * 25e-6 = 0.0025; eff = 0.008
    assert.ok(Math.abs(eff.effective_usd - 0.008) < 1e-9);
    // nominal treats cacheRead at full input rate: (1000+1000) * 5e-6 + 100 * 25e-6 = 0.0125
    assert.ok(Math.abs(eff.nominal_usd - 0.0125) < 1e-9);
  });
});

describe("effectiveCost — happy path with full cache", () => {
  it("SHOULD apply per-component multipliers and surface attribution in notes", () => {
    const cache: CachePricing = {
      cachedInput: component({ usdPerMillion: 0.5, ratioOfInput: 0.1, source: "anthropic-pricing" }),
      cacheWrite5m: component({ usdPerMillion: 6.25, ratioOfInput: 1.25, source: "anthropic-pricing" }),
      cacheWrite1h: component({ usdPerMillion: 10, ratioOfInput: 2.0, source: "anthropic-pricing" }),
    };
    const price = priceWithCache(cache);
    const eff = effectiveCost(price, 1000, 1000, 1000, 100);
    // raw 0.005 + read 0.0005 + create-5m 0.00625 + output 0.0025 = 0.01425
    assert.ok(Math.abs(eff.effective_usd - 0.01425) < 1e-9);
    assert.equal(eff.cache_attribution, cache);
    assert.match(eff.notes[0], /read 0\.1×/);
    assert.match(eff.notes[0], /write-5m 1\.25×/);
    assert.match(eff.notes[0], /write-1h 2×/);
    assert.match(eff.notes[0], /anthropic-pricing/);
  });

  it("SHOULD render manual source without URL gracefully", () => {
    const cache: CachePricing = {
      cachedInput: component({ source: "manual", sourceUrl: null, ratioOfInput: 1.0 }),
      cacheWrite5m: null,
      cacheWrite1h: null,
    };
    const price = priceWithCache(cache);
    const eff = effectiveCost(price, 0, 0, 0, 100);
    assert.match(eff.notes[0], /\(manual\)/);
    assert.doesNotMatch(eff.notes[0], / — http/);
  });
});

describe("adaptComponent — boundary normalization", () => {
  it("SHOULD return null IF raw component is null", () => {
    assert.equal(adaptComponent("m", "cachedInput", 5, null), null);
  });

  it("SHOULD return null IF raw component is undefined", () => {
    assert.equal(adaptComponent("m", "cachedInput", 5, undefined), null);
  });

  it("SHOULD derive ratioOfInput from usdPerMillion when ratio is null", () => {
    const out = adaptComponent("m", "cachedInput", 5, {
      usdPerMillion: 0.5,
      ratioOfInput: null,
      source: "x",
      sourceUrl: null,
      createdAt: "2026-01-01T00:00:00Z",
    });
    assert.ok(out);
    assert.equal(out.usdPerMillion, 0.5);
    assert.equal(out.ratioOfInput, 0.1);
  });

  it("SHOULD derive usdPerMillion from ratioOfInput when usd is null", () => {
    const out = adaptComponent("m", "cachedInput", 5, {
      usdPerMillion: null,
      ratioOfInput: 0.2,
      source: "x",
      sourceUrl: null,
      createdAt: "2026-01-01T00:00:00Z",
    });
    assert.ok(out);
    assert.equal(out.usdPerMillion, 1);
    assert.equal(out.ratioOfInput, 0.2);
  });

  it("SHOULD throw IF both usdPerMillion and ratioOfInput are null", () => {
    assert.throws(() =>
      adaptComponent("model-x", "cachedInput", 5, {
        usdPerMillion: null,
        ratioOfInput: null,
        source: "x",
        sourceUrl: null,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
  });

  it("SHOULD throw IF only usd is given and inputUsdPerMillion is 0 (cannot derive ratio)", () => {
    assert.throws(() =>
      adaptComponent("model-x", "cachedInput", 0, {
        usdPerMillion: 1.5,
        ratioOfInput: null,
        source: "x",
        sourceUrl: null,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
  });

  it("SHOULD preserve both values when both present", () => {
    const out = adaptComponent("m", "cachedInput", 5, {
      usdPerMillion: 0.5,
      ratioOfInput: 0.1,
      source: "anthropic-pricing",
      sourceUrl: "https://...",
      createdAt: "2026-01-01T00:00:00Z",
    });
    assert.ok(out);
    assert.equal(out.usdPerMillion, 0.5);
    assert.equal(out.ratioOfInput, 0.1);
    assert.equal(out.source, "anthropic-pricing");
    assert.equal(out.sourceUrl, "https://...");
  });
});

describe("adaptCache — block-level", () => {
  it("SHOULD return null when block is null", () => {
    assert.equal(adaptCache("m", 5, null), null);
  });

  it("SHOULD return null when block is undefined", () => {
    assert.equal(adaptCache("m", 5, undefined), null);
  });

  it("SHOULD pass through per-component nulls verbatim", () => {
    const out = adaptCache("m", 5, {
      cachedInput: {
        usdPerMillion: 0.5,
        ratioOfInput: 0.1,
        source: "x",
        sourceUrl: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
      cacheWrite5m: null,
      cacheWrite1h: null,
    });
    assert.ok(out);
    assert.ok(out.cachedInput);
    assert.equal(out.cacheWrite5m, null);
    assert.equal(out.cacheWrite1h, null);
  });
});

describe("priceSession — unified result", () => {
  it("SHOULD return effective + nominal + null missing on happy path", () => {
    const cache: CachePricing = {
      cachedInput: component(),
      cacheWrite5m: component({ ratioOfInput: 1.25, usdPerMillion: 6.25 }),
      cacheWrite1h: null,
    };
    const r = priceSession(priceWithCache(cache), 1000, 100, 100, 100);
    assert.ok(r.effective);
    assert.equal(r.cache_pricing_missing, null);
    assert.equal(r.nominal_usd, r.effective.nominal_usd);
  });

  it("SHOULD return null effective + structured missing + nominal on cache-block-absent path", () => {
    const r = priceSession(priceWithCache(null), 1000, 100, 0, 100);
    assert.equal(r.effective, null);
    assert.ok(r.cache_pricing_missing instanceof OracleCachePricingMissingError);
    assert.equal(r.cache_pricing_missing.missing, "block");
    assert.ok(r.nominal_usd > 0);
  });

});

describe("effectiveCost — breakdown integrity", () => {
  it("SHOULD set cache_read_usd=0 and cache_create_usd=0 when no cache tokens", () => {
    const cache: CachePricing = {
      cachedInput: component(),
      cacheWrite5m: component(),
      cacheWrite1h: component(),
    };
    const price = priceWithCache(cache);
    const eff = effectiveCost(price, 1000, 0, 0, 100);
    assert.equal(eff.breakdown.cache_read_usd, 0);
    assert.equal(eff.breakdown.cache_create_usd, 0);
    assert.ok(eff.breakdown.raw_input_usd > 0);
    assert.ok(eff.breakdown.output_usd > 0);
  });
});

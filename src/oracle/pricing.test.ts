import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cacheAttributionNote,
  effectiveCost,
  nominalCost,
  priceSession,
  OracleCachePricingMissingError,
} from "./pricing.js";
import type { CachePricing, ModelPrice, PriceComponent } from "./types.js";

function component(over: Partial<PriceComponent> = {}): PriceComponent {
  return {
    usdPerMillion: 0.5,
    ratioOfInput: 0.1,
    provenance: "verified",
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
    released_at: null,
    base_input_usd_per_million: 5,
    base_output_usd_per_million: 25,
    base_price_provenance: null,
    cache,
    reasoning: null,
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

describe("effectiveCost — full cache pricing", () => {
  it("SHOULD apply per-component multipliers and surface attribution in notes", () => {
    const cache: CachePricing = {
      cachedInput: component({ usdPerMillion: 0.5, ratioOfInput: 0.1 }),
      cacheWrite5m: component({ usdPerMillion: 6.25, ratioOfInput: 1.25 }),
      cacheWrite1h: component({ usdPerMillion: 10, ratioOfInput: 2.0 }),
    };
    const price = priceWithCache(cache);
    const eff = effectiveCost(price, 1000, 1000, 1000, 100);
    // raw 0.005 + read 0.0005 + create-5m 0.00625 + output 0.0025 = 0.01425
    assert.ok(Math.abs(eff.effective_usd - 0.01425) < 1e-9);
    assert.equal(eff.cache_attribution, cache);
    assert.match(eff.notes[0], /read 0\.1×/);
    assert.match(eff.notes[0], /write-5m 1\.25×/);
    assert.match(eff.notes[0], /write-1h 2×/);
  });

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

describe("cacheAttributionNote", () => {
  it("SHOULD mark each multiplier WITH its own provenance — Bug guarded: one mark reused across components hides a verified read sitting next to an inferred write", () => {
    const cache: CachePricing = {
      cachedInput: component({ ratioOfInput: 0.1, provenance: "verified" }),
      cacheWrite5m: component({ ratioOfInput: 1.25, provenance: "inferred" }),
      cacheWrite1h: component({ ratioOfInput: 2.0, provenance: "promotional" }),
    };
    assert.equal(
      cacheAttributionNote(cache),
      "Oracle cache multipliers: read 0.1× (verified) · write-5m 1.25× (inferred) · write-1h 2× (promotional)",
    );
  });

  it("SHOULD return null IF there is no multiplier to attribute", () => {
    assert.equal(cacheAttributionNote(null), null);
    assert.equal(
      cacheAttributionNote({ cachedInput: null, cacheWrite5m: null, cacheWrite1h: null }),
      null,
    );
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

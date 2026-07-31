import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { usdCost, withBilledPrices } from "./pricing-view.js";
import type { ModelPrice } from "./types.js";

function price(over: Partial<ModelPrice> = {}): ModelPrice {
  return {
    model: "claude-opus-5",
    display_name: "Claude Opus 5",
    provider: "anthropic",
    provider_name: "Anthropic",
    family: "anthropic.claude-opus",
    released_at: null,
    base_input_usd_per_million: 5,
    base_output_usd_per_million: 25,
    base_input_wei_per_million: 100,
    base_output_wei_per_million: 500,
    cache: null,
    ...over,
  };
}

describe("withBilledPrices", () => {
  it("SHOULD add the routing fee to every base price", () => {
    const p = withBilledPrices(price(), 0.05);
    assert.equal(p.billed_input_usd_per_million, 5.25);
    assert.equal(p.billed_output_usd_per_million, 26.25);
    assert.equal(p.billed_input_wei_per_million, 105);
    assert.equal(p.billed_output_wei_per_million, 525);
  });

  it("SHOULD leave the base prices untouched — Bug guarded: applying the fee in place erases the only figure comparable across providers", () => {
    const p = withBilledPrices(price(), 0.05);
    assert.equal(p.base_input_usd_per_million, 5);
    assert.equal(p.base_output_usd_per_million, 25);
  });

  it("SHOULD null every billed price IF the rate is unknown — Bug guarded: falling through to the base price would present an unknown fee as no fee", () => {
    const p = withBilledPrices(price(), null);
    assert.equal(p.billed_input_usd_per_million, null);
    assert.equal(p.billed_output_usd_per_million, null);
    assert.equal(p.billed_input_wei_per_million, null);
    assert.equal(p.billed_output_wei_per_million, null);
  });

  it("SHOULD null the billed wei price IF the oracle published no base wei price", () => {
    const p = withBilledPrices(
      price({ base_input_wei_per_million: null, base_output_wei_per_million: null }),
      0.05,
    );
    assert.equal(p.billed_input_wei_per_million, null);
    assert.equal(p.billed_output_wei_per_million, null);
    assert.equal(p.billed_input_usd_per_million, 5.25);
  });
});

describe("usdCost", () => {
  it("SHOULD return identical costs FOR two models that share provider prices — Bug guarded: basket membership must not move the number", () => {
    const basketMember = price({ model: "in-basket" });
    const catalogOnly = price({
      model: "catalog-only",
      base_input_wei_per_million: null,
      base_output_wei_per_million: null,
    });
    assert.deepEqual(
      usdCost(basketMember, 1_000_000, 1_000_000, 0.05),
      usdCost(catalogOnly, 1_000_000, 1_000_000, 0.05),
    );
  });

  it("SHOULD reconcile base + fee into the billed cost exactly — Bug guarded: independently rounded parts that do not add up read as an arithmetic error to a caller", () => {
    const c = usdCost(price(), 137_413, 9_871, 0.05);
    assert.equal(c.base_usd_cost + c.routing_fee_usd!, c.billed_usd_cost);
  });

  it("SHOULD price a workload on both bases", () => {
    const c = usdCost(price(), 1_000_000, 1_000_000, 0.05);
    assert.equal(c.base_usd_cost, 30);
    assert.equal(c.billed_usd_cost, 31.5);
    assert.equal(c.routing_fee_usd, 1.5);
  });

  it("SHOULD keep the base cost and null the fee IF the rate is unknown", () => {
    const c = usdCost(price(), 1_000_000, 1_000_000, null);
    assert.equal(c.base_usd_cost, 30);
    assert.equal(c.billed_usd_cost, null);
    assert.equal(c.routing_fee_usd, null);
  });
});

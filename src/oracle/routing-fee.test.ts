import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { applyRoutingFee, getRoutingFeeRate } from "./routing-fee.js";
import { _resetOracleCache } from "./client.js";
import { _resetFieldMap, _seedDefaultFieldMap } from "./field-map.js";

let originalFetch: typeof globalThis.fetch;

function mockBasket(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetOracleCache();
  _resetFieldMap();
  _seedDefaultFieldMap();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetFieldMap();
});

describe("applyRoutingFee", () => {
  it("SHOULD return the exact product, not the oracle's rounded display figure — Bug guarded: the oracle publishes markedUpUsdPricePerMillion rounded for display, so copying it drifts from what billing charges", () => {
    assert.equal(applyRoutingFee(0.19, 0.05), 0.1995);
    assert.equal(applyRoutingFee(2.5, 0.05), 2.625);
    assert.equal(applyRoutingFee(0.435, 0.05), 0.45675);
  });

  it("SHOULD not leak binary floating-point noise into the price", () => {
    assert.equal(applyRoutingFee(5, 0.05), 5.25);
    assert.equal(applyRoutingFee(0.75, 0.05), 0.7875);
    assert.equal(applyRoutingFee(4.5, 0.05), 4.725);
  });

  it("SHOULD return the base price unchanged FOR a zero rate", () => {
    assert.equal(applyRoutingFee(12.34, 0), 12.34);
  });
});

describe("getRoutingFeeRate", () => {
  it("SHOULD read the rate published at the top level of the basket", async () => {
    mockBasket({ models: [], routingFeeRate: 0.05 });
    assert.equal(await getRoutingFeeRate(), 0.05);
  });

  it("SHOULD return null IF the basket publishes no rate — Bug guarded: falling back to a hardcoded 5% would keep reporting a stale fee after the protocol changes it", async () => {
    mockBasket({ models: [] });
    assert.equal(await getRoutingFeeRate(), null);
  });

  it("SHOULD return null IF the rate is not a usable number", async () => {
    mockBasket({ models: [], routingFeeRate: "0.05" });
    assert.equal(await getRoutingFeeRate(), null);
    _resetOracleCache();
    mockBasket({ models: [], routingFeeRate: -0.05 });
    assert.equal(await getRoutingFeeRate(), null);
  });

  it("SHOULD return null IF the basket request fails — Bug guarded: an oracle outage must degrade to a base-only answer, not throw and sink the whole tool call", async () => {
    mockBasket({ error: "boom" }, 503);
    assert.equal(await getRoutingFeeRate(), null);
  });
});

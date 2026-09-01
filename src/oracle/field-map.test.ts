import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _internals } from "./field-map.js";

const { deriveBasketMap, deriveReconMap } = _internals;

const LIVE_BASKET_SCHEMA = {
  type: "object",
  properties: {
    models: { type: "array", items: { type: "object", properties: {} } },
    scu: { type: "object", properties: {} },
    scuUsd: { type: "number" },
    routingFeeRate: { type: "number" },
    basketVersion: { type: "number" },
    lastUpdated: { type: "string" },
  },
};

describe("deriveBasketMap", () => {
  it("maps the routing fee rate from the live schema", () => {
    const { map, mismatches, unmapped } = deriveBasketMap(LIVE_BASKET_SCHEMA as any);
    assert.equal(map.routing_fee_rate, "routingFeeRate");
    assert.equal(mismatches.length, 0);
    assert.equal(unmapped.length, 0);
  });

  it("auto-discovers a renamed rate field", () => {
    const schema = JSON.parse(JSON.stringify(LIVE_BASKET_SCHEMA));
    schema.properties.routingMarkupRate = schema.properties.routingFeeRate;
    delete schema.properties.routingFeeRate;

    const { map, mismatches } = deriveBasketMap(schema as any);
    assert.equal(map.routing_fee_rate, "routingMarkupRate");
    assert.ok(mismatches.some((m: string) => m.includes("routing_fee_rate")));
  });

  it("SHOULD report routing_fee_rate unmapped IF the basket publishes no rate — Bug guarded: a missing rate must surface, not silently resolve to some other number", () => {
    const schema = JSON.parse(JSON.stringify(LIVE_BASKET_SCHEMA));
    delete schema.properties.routingFeeRate;
    const { unmapped } = deriveBasketMap(schema as any);
    assert.ok(unmapped.includes("routing_fee_rate"));
  });

  it("SHOULD NOT map any per-model price field — Bug guarded: a price read off the attested snapshot is a price the exchange no longer bills", () => {
    const { map } = deriveBasketMap(LIVE_BASKET_SCHEMA as any);
    assert.deepEqual(Object.keys(map), ["routing_fee_rate"]);
  });
});

describe("deriveReconMap", () => {
  const RECON_SCHEMA = {
    type: "object",
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            publishedAt: { type: "string", format: "date-time" },
            summary: { type: "string" },
            basketVersion: { type: "number" },
          },
        },
      },
    },
  };

  it("maps current schema correctly", () => {
    const { map, mismatches, unmapped } = deriveReconMap(RECON_SCHEMA as any);
    assert.equal(map.entries_array, "entries");
    assert.equal(map.sort_date, "publishedAt");
    assert.equal(mismatches.length, 0);
    assert.equal(unmapped.length, 0);
  });

  it("discovers entries → events rename", () => {
    const schema = JSON.parse(JSON.stringify(RECON_SCHEMA));
    schema.properties.events = schema.properties.entries;
    delete schema.properties.entries;

    const { map, mismatches } = deriveReconMap(schema as any);
    assert.equal(map.entries_array, "events");
    assert.ok(mismatches.some((m: string) => m.includes("entries_array")));
  });

  it("discovers publishedAt → date rename", () => {
    const schema = JSON.parse(JSON.stringify(RECON_SCHEMA));
    const items = schema.properties.entries.items;
    items.properties.effectiveDate = items.properties.publishedAt;
    delete items.properties.publishedAt;

    const { map, mismatches } = deriveReconMap(schema as any);
    assert.equal(map.sort_date, "effectiveDate");
    assert.ok(mismatches.some((m: string) => m.includes("sort_date")));
  });
});

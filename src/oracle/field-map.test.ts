/**
 * Unit tests for field-map module.
 *
 * Run with: npx tsx --test src/oracle/field-map.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _internals, DEFAULT_BASKET } from "./field-map.js";

const { findField, deriveBasketMap, deriveReconMap } = _internals;

// ── Mock schemas matching live Oracle OpenAPI ───────────────────────

const LIVE_MODEL_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    displayName: { type: "string" },
    provider: {
      type: "object",
      properties: {
        key: { type: "string" },
        name: { type: "string" },
      },
      required: ["key", "name"],
    },
    family: { type: "string" },
    integrated: { type: "boolean" },
    weiPricePerMillion: {
      type: "object",
      properties: { input: { type: "number" }, output: { type: "number" } },
    },
    usdPricePerMillion: {
      type: "object",
      properties: { input: { type: "number" }, output: { type: "number" } },
    },
    markedUpWeiPricePerMillion: {
      type: "object",
      properties: { input: { type: "number" }, output: { type: "number" } },
    },
    markedUpUsdPricePerMillion: {
      type: "object",
      properties: { input: { type: "number" }, output: { type: "number" } },
    },
    oracleKeyPrefix: { type: "string" },
    releasedAt: { type: "string", format: "date-time", nullable: true },
  },
};

const LIVE_BASKET_SCHEMA = {
  type: "object",
  properties: {
    models: { type: "array", items: LIVE_MODEL_SCHEMA },
    scu: { type: "object", properties: {} },
    scuUsd: { type: "number" },
    routingFeeRate: { type: "number" },
    basketVersion: { type: "number" },
    lastUpdated: { type: "string" },
  },
};

// ── Tests: findField ────────────────────────────────────────────────

describe("findField", () => {
  const props = LIVE_MODEL_SCHEMA.properties as any;

  it("exact match on default name", () => {
    const r = findField(props, "id", { required: ["id"], type: "string" });
    assert.ok(r);
    assert.equal(r!.name, "id");
    assert.equal(r!.exact, true);
  });

  it("discovers renamed field via keywords", () => {
    const renamedProps = { ...props } as any;
    delete renamedProps.displayName;
    renamedProps.modelDisplayName = { type: "string" };
    const r = findField(renamedProps, "displayName", {
      required: ["name"],
      preferred: ["display"],
      type: "string",
      exclude: ["provider"],
    });
    assert.ok(r);
    assert.equal(r!.name, "modelDisplayName");
    assert.equal(r!.exact, false);
  });

  it("returns null when no match", () => {
    const r = findField(props, "nonexistent", {
      required: ["zzz"],
      type: "string",
    });
    assert.equal(r, null);
  });

  it("excludes fields matching exclude keywords", () => {
    const r = findField(props, "nonexistent", {
      required: ["id"],
      type: "string",
      exclude: ["id"],
    });
    assert.equal(r, null);
  });
});

// ── Tests: deriveBasketMap ──────────────────────────────────────────

describe("deriveBasketMap — current schema", () => {
  it("maps all fields correctly from live schema", () => {
    const { map, mismatches, unmapped } = deriveBasketMap(LIVE_BASKET_SCHEMA as any);
    assert.equal(map.models_array, "models");
    assert.equal(map.model_id, "id");
    assert.equal(map.display_name, "displayName");
    assert.equal(map.provider, "provider");
    assert.equal(map.provider_key, "key");
    assert.equal(map.provider_name, "name");
    assert.equal(map.family, "family");
    assert.equal(map.integrated, "integrated");
    assert.equal(map.released_at, "releasedAt");
    assert.equal(map.marked_up_usd_price, "markedUpUsdPricePerMillion");
    assert.equal(map.marked_up_wei_price, "markedUpWeiPricePerMillion");
    assert.equal(mismatches.length, 0);
    assert.equal(unmapped.length, 0);
  });
});

describe("deriveBasketMap — simulated renames", () => {
  it("auto-discovers wei → compute rename", () => {
    const renamedModel = JSON.parse(JSON.stringify(LIVE_MODEL_SCHEMA));
    renamedModel.properties.markedUpComputePricePerMillion =
      renamedModel.properties.markedUpWeiPricePerMillion;
    delete renamedModel.properties.markedUpWeiPricePerMillion;
    renamedModel.properties.computePricePerMillion =
      renamedModel.properties.weiPricePerMillion;
    delete renamedModel.properties.weiPricePerMillion;

    const schema = {
      ...LIVE_BASKET_SCHEMA,
      properties: {
        ...LIVE_BASKET_SCHEMA.properties,
        models: { type: "array", items: renamedModel },
      },
    };

    const { map, mismatches } = deriveBasketMap(schema as any);
    assert.equal(map.marked_up_wei_price, "markedUpComputePricePerMillion");
    assert.ok(mismatches.some((m) => m.includes("marked_up_wei_price")));
    assert.equal(map.marked_up_usd_price, "markedUpUsdPricePerMillion");
  });

  it("auto-discovers models array rename", () => {
    const schema = JSON.parse(JSON.stringify(LIVE_BASKET_SCHEMA));
    schema.properties.basketModels = schema.properties.models;
    delete schema.properties.models;

    const { map, mismatches } = deriveBasketMap(schema as any);
    assert.equal(map.models_array, "basketModels");
    assert.ok(mismatches.some((m) => m.includes("models_array")));
  });

  it("auto-discovers displayName → label rename", () => {
    const renamedModel = JSON.parse(JSON.stringify(LIVE_MODEL_SCHEMA));
    renamedModel.properties.displayLabel = renamedModel.properties.displayName;
    delete renamedModel.properties.displayName;
    // "displayLabel" doesn't match required ["name"] — wouldn't find it.
    // But if renamed to e.g. "modelName":
    renamedModel.properties.modelName = renamedModel.properties.displayLabel;
    delete renamedModel.properties.displayLabel;

    const schema = {
      ...LIVE_BASKET_SCHEMA,
      properties: {
        ...LIVE_BASKET_SCHEMA.properties,
        models: { type: "array", items: renamedModel },
      },
    };

    const { map, mismatches } = deriveBasketMap(schema as any);
    assert.equal(map.display_name, "modelName");
    assert.ok(mismatches.some((m) => m.includes("display_name")));
  });

  it("auto-discovers provider subfield renames", () => {
    const renamedModel = JSON.parse(JSON.stringify(LIVE_MODEL_SCHEMA));
    renamedModel.properties.provider = {
      type: "object",
      properties: {
        providerKey: { type: "string" },
        providerName: { type: "string" },
      },
    };

    const schema = {
      ...LIVE_BASKET_SCHEMA,
      properties: {
        ...LIVE_BASKET_SCHEMA.properties,
        models: { type: "array", items: renamedModel },
      },
    };

    const { map, mismatches } = deriveBasketMap(schema as any);
    assert.equal(map.provider_key, "providerKey");
    assert.equal(map.provider_name, "providerName");
    assert.ok(mismatches.some((m) => m.includes("provider_key")));
    assert.ok(mismatches.some((m) => m.includes("provider_name")));
  });
});

// ── Tests: deriveReconMap ───────────────────────────────────────────

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
    assert.ok(mismatches.some((m) => m.includes("entries_array")));
  });

  it("discovers publishedAt → date rename", () => {
    const schema = JSON.parse(JSON.stringify(RECON_SCHEMA));
    const items = schema.properties.entries.items;
    items.properties.effectiveDate = items.properties.publishedAt;
    delete items.properties.publishedAt;

    const { map, mismatches } = deriveReconMap(schema as any);
    assert.equal(map.sort_date, "effectiveDate");
    assert.ok(mismatches.some((m) => m.includes("sort_date")));
  });
});

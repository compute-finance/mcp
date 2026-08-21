import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  getAllOracleToolResponseSchemas,
  _resetCache,
  _internals,
} from "./openapi-schema.js";

const { buildResponseSchemaMap, deepResolveSchema, extractResponseSchema, resolveRef } =
  _internals;

const MOCK_SPEC = {
  paths: {
    "/v1/oracle/scu": {
      get: {
        operationId: "OraclePublicController_getScu",
        parameters: [],
        responses: {
          "200": {
            description: "SCU data",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ScuResponseDto" },
              },
            },
          },
        },
      },
    },
    "/v1/oracle/model/{key}": {
      get: {
        operationId: "OraclePublicController_getModel",
        parameters: [
          {
            name: "key",
            required: true,
            in: "path" as const,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Model data",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ModelDto" },
              },
            },
          },
        },
      },
    },
    "/v1/oracle/basket": {
      get: {
        operationId: "OraclePublicController_getBasket",
        parameters: [],
        responses: {
          "200": {
            description: "Basket data",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BasketResponseDto" },
              },
            },
          },
        },
      },
    },
    "/v1/oracle/reconstitutions": {
      get: {
        operationId: "OraclePublicController_getReconstitutions",
        parameters: [],
      },
    },
  },
  components: {
    schemas: {
      ScuResponseDto: {
        type: "object",
        properties: { scuUsd: { type: "number" } },
      },
      ModelDto: {
        type: "object",
        properties: {
          id: { type: "string" },
          family: { type: "string" },
        },
      },
      BasketResponseDto: {
        type: "object",
        properties: {
          models: {
            type: "array",
            items: { $ref: "#/components/schemas/ModelDto" },
          },
          scuUsd: { type: "number" },
        },
      },
    },
  },
};

describe("resolveRef", () => {
  it("resolves a valid $ref path", () => {
    const result = resolveRef(
      MOCK_SPEC as any,
      "#/components/schemas/ScuResponseDto",
    );
    assert.deepEqual(result, {
      type: "object",
      properties: { scuUsd: { type: "number" } },
    });
  });

  it("returns null for missing $ref", () => {
    const result = resolveRef(MOCK_SPEC as any, "#/components/schemas/Missing");
    assert.equal(result, null);
  });
});

describe("deepResolveSchema", () => {
  it("resolves a top-level $ref", () => {
    const result = deepResolveSchema(MOCK_SPEC as any, {
      $ref: "#/components/schemas/ScuResponseDto",
    });
    assert.equal(result.type, "object");
    const props = result.properties as Record<string, Record<string, unknown>>;
    assert.ok("scuUsd" in props);
  });

  it("resolves nested $refs in array items", () => {
    const result = deepResolveSchema(MOCK_SPEC as any, {
      type: "array",
      items: { $ref: "#/components/schemas/ModelDto" },
    });
    const items = result.items as Record<string, unknown>;
    assert.equal(items.type, "object");
    const props = (items as any).properties;
    assert.ok("id" in props);
    assert.ok("family" in props);
  });

  it("resolves $refs in object properties", () => {
    const result = deepResolveSchema(MOCK_SPEC as any, {
      $ref: "#/components/schemas/BasketResponseDto",
    });
    assert.equal(result.type, "object");
    const props = result.properties as Record<string, any>;
    assert.ok("models" in props);
    const items = props.models.items;
    assert.equal(items.type, "object");
    assert.ok("id" in items.properties);
  });

  it("returns schema as-is at depth limit", () => {
    const ref = { $ref: "#/components/schemas/ScuResponseDto" };
    const result = deepResolveSchema(MOCK_SPEC as any, ref, 9);
    assert.equal(result.$ref, "#/components/schemas/ScuResponseDto");
  });

  it("returns original schema when $ref target missing", () => {
    const ref = { $ref: "#/components/schemas/Nonexistent" };
    const result = deepResolveSchema(MOCK_SPEC as any, ref);
    assert.equal(result.$ref, "#/components/schemas/Nonexistent");
  });
});

describe("extractResponseSchema", () => {
  it("extracts 200 response JSON schema", () => {
    const op = MOCK_SPEC.paths["/v1/oracle/scu"].get;
    const schema = extractResponseSchema(MOCK_SPEC as any, op as any);
    assert.ok(schema);
    assert.equal(schema!.type, "object");
    const props = schema!.properties as Record<string, unknown>;
    assert.ok("scuUsd" in props);
  });

  it("returns fully-resolved schema for nested $refs", () => {
    const op = MOCK_SPEC.paths["/v1/oracle/basket"].get;
    const schema = extractResponseSchema(MOCK_SPEC as any, op as any);
    assert.ok(schema);
    const props = schema!.properties as Record<string, any>;
    assert.ok("models" in props);
    const items = props.models.items;
    assert.equal(items.type, "object");
    assert.ok("id" in items.properties);
  });

  it("returns null when no responses defined", () => {
    const op = { operationId: "test_no_responses", parameters: [] };
    const schema = extractResponseSchema(MOCK_SPEC as any, op as any);
    assert.equal(schema, null);
  });

  it("returns null when no application/json content", () => {
    const op = {
      operationId: "test",
      responses: { "200": { description: "ok", content: {} } },
    };
    const schema = extractResponseSchema(MOCK_SPEC as any, op as any);
    assert.equal(schema, null);
  });
});

describe("buildResponseSchemaMap", () => {
  it("builds map from operations with response schemas", () => {
    const map = buildResponseSchemaMap(MOCK_SPEC as any);
    assert.ok(map.has("OraclePublicController_getScu"));
    assert.ok(map.has("OraclePublicController_getModel"));
    assert.ok(map.has("OraclePublicController_getBasket"));
  });

  it("skips operations without response schemas", () => {
    const map = buildResponseSchemaMap(MOCK_SPEC as any);
    assert.ok(!map.has("OraclePublicController_getReconstitutions"));
  });

  it("response schemas are fully resolved", () => {
    const map = buildResponseSchemaMap(MOCK_SPEC as any);
    const basketSchema = map.get("OraclePublicController_getBasket")!;
    assert.ok(basketSchema);
    const props = basketSchema.properties as Record<string, any>;
    const items = props.models.items;
    assert.equal(items.type, "object");
    assert.ok(!("$ref" in items));
  });
});

describe("getAllOracleToolResponseSchemas (mocked fetch)", () => {
  beforeEach(() => {
    _resetCache();
    (globalThis as any).fetch = mock.fn(async () => ({
      ok: true,
      json: async () => MOCK_SPEC,
    }));
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("returns response schemas for tools with documented responses", async () => {
    const schemas = await getAllOracleToolResponseSchemas();
    assert.ok("data_get_basket" in schemas);
    assert.ok("data_get_price" in schemas);
    assert.ok("data_get_scu" in schemas);
    assert.ok("data_get_cpi" in schemas);
  });

  it("omits tools without documented response schemas", async () => {
    const schemas = await getAllOracleToolResponseSchemas();
    assert.ok(!("data_get_tiers" in schemas));
    assert.ok(!("data_get_reconstitutions" in schemas));
  });

  it("returns empty object when fetch fails", async () => {
    (globalThis as any).fetch = mock.fn(async () => { throw new Error("network down"); });
    const schemas = await getAllOracleToolResponseSchemas();
    assert.deepEqual(schemas, {});
  });

  it("response schemas are fully resolved (no $ref)", async () => {
    const schemas = await getAllOracleToolResponseSchemas();
    const basket = schemas.data_get_basket;
    assert.ok(basket);
    const props = basket.properties as Record<string, any>;
    assert.ok("models" in props);
    const items = props.models.items;
    assert.equal(items.type, "object");
    assert.ok(!("$ref" in items));
  });
});

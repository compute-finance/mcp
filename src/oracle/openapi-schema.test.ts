/**
 * Unit tests for openapi-schema module.
 *
 * Uses Node's built-in test runner (node:test) — no extra dev dependency.
 * Run with: npx tsx --test src/oracle/openapi-schema.test.ts
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  getToolInputSchema,
  getAllOracleToolSchemas,
  getAllOracleToolResponseSchemas,
  isOracleBackedTool,
  _resetCache,
  _internals,
} from "./openapi-schema.js";

const {
  buildInputSchema,
  buildSchemaMap,
  buildResponseSchemaMap,
  deepResolveSchema,
  extractResponseSchema,
  resolveRef,
  applyRenames,
  applyMcpExtras,
} = _internals;

// ── Fixtures ─────────────────────────────────────────────────────────

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
    "/v1/oracle/tiers": {
      get: {
        operationId: "OraclePublicController_getTiers",
        parameters: [],
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
          tier: { type: "string" },
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

// ── Tests ────────────────────────────────────────────────────────────

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

describe("buildInputSchema", () => {
  it("returns empty object for parameterless operation", () => {
    const op = { operationId: "test", parameters: [] };
    const schema = buildInputSchema(MOCK_SPEC as any, op);
    assert.deepEqual(schema, { type: "object", properties: {} });
  });

  it("builds schema from path parameters", () => {
    const op = {
      operationId: "test",
      parameters: [
        { name: "key", required: true, in: "path" as const, schema: { type: "string" } },
      ],
    };
    const schema = buildInputSchema(MOCK_SPEC as any, op);
    assert.deepEqual(schema, {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    });
  });

  it("includes query parameters", () => {
    const op = {
      operationId: "test",
      parameters: [
        {
          name: "limit",
          required: false,
          in: "query" as const,
          schema: { type: "number" },
          description: "Max items",
        },
      ],
    };
    const schema = buildInputSchema(MOCK_SPEC as any, op);
    assert.deepEqual(schema, {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max items" },
      },
    });
  });

  it("excludes header parameters", () => {
    const op = {
      operationId: "test",
      parameters: [
        { name: "Authorization", required: true, in: "header" as const, schema: { type: "string" } },
      ],
    };
    const schema = buildInputSchema(MOCK_SPEC as any, op);
    assert.deepEqual(schema, { type: "object", properties: {} });
  });
});

describe("buildSchemaMap", () => {
  it("builds map from all operationIds", () => {
    const map = buildSchemaMap(MOCK_SPEC as any);
    assert.equal(map.size, 5);
    assert.ok(map.has("OraclePublicController_getScu"));
    assert.ok(map.has("OraclePublicController_getModel"));
    assert.ok(map.has("OraclePublicController_getBasket"));
  });

  it("parameterless operations get empty properties", () => {
    const map = buildSchemaMap(MOCK_SPEC as any);
    assert.deepEqual(map.get("OraclePublicController_getScu"), {
      type: "object",
      properties: {},
    });
  });

  it("getModel has required key parameter", () => {
    const map = buildSchemaMap(MOCK_SPEC as any);
    const schema = map.get("OraclePublicController_getModel");
    assert.ok(schema);
    assert.deepEqual(schema.required, ["key"]);
    const props = schema.properties as Record<string, unknown>;
    assert.ok("key" in props);
  });
});

describe("applyRenames", () => {
  it("renames key to model for data_get_price", () => {
    const schema = {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    };
    const result = applyRenames("data_get_price", schema);
    assert.ok("model" in (result.properties as Record<string, unknown>));
    assert.ok(!("key" in (result.properties as Record<string, unknown>)));
    assert.deepEqual(result.required, ["model"]);
  });

  it("passes through for tools without renames", () => {
    const schema = { type: "object", properties: {} };
    const result = applyRenames("data_get_scu", schema);
    assert.deepEqual(result, schema);
  });
});

describe("applyMcpExtras", () => {
  it("adds limit to data_get_reconstitutions", () => {
    const schema = { type: "object", properties: {} } as Record<string, unknown>;
    const result = applyMcpExtras("data_get_reconstitutions", schema);
    const props = result.properties as Record<string, Record<string, unknown>>;
    assert.ok("limit" in props);
    assert.equal(props.limit.type, "number");
  });

  it("adds model description to data_get_price", () => {
    const schema = {
      type: "object",
      properties: { model: { type: "string" } },
    } as Record<string, unknown>;
    const result = applyMcpExtras("data_get_price", schema);
    const props = result.properties as Record<string, Record<string, unknown>>;
    assert.equal(props.model.type, "string");
    assert.equal(props.model.description, "Model name, e.g. claude-sonnet-4.6");
  });
});

describe("isOracleBackedTool", () => {
  it("returns true for oracle-backed tools", () => {
    assert.ok(isOracleBackedTool("data_get_basket"));
    assert.ok(isOracleBackedTool("data_get_price"));
    assert.ok(isOracleBackedTool("data_get_scu"));
  });

  it("returns false for local tools", () => {
    assert.ok(!isOracleBackedTool("compute_estimate"));
    assert.ok(!isOracleBackedTool("render_session_report"));
    assert.ok(!isOracleBackedTool("telemetry_get_history"));
  });
});

describe("getToolInputSchema (with fallback)", () => {
  beforeEach(() => {
    _resetCache();
  });

  it("returns fallback for non-oracle tools", async () => {
    const schema = await getToolInputSchema("compute_estimate");
    assert.deepEqual(schema, { type: "object", properties: {} });
  });

  it("returns hardcoded fallback for unknown tools", async () => {
    const schema = await getToolInputSchema("nonexistent_tool");
    assert.deepEqual(schema, { type: "object", properties: {} });
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
    assert.ok("tier" in props);
  });

  it("resolves $refs in object properties", () => {
    const result = deepResolveSchema(MOCK_SPEC as any, {
      $ref: "#/components/schemas/BasketResponseDto",
    });
    assert.equal(result.type, "object");
    const props = result.properties as Record<string, any>;
    assert.ok("models" in props);
    // items inside models array should also be resolved
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
    const op = MOCK_SPEC.paths["/v1/oracle/tiers"].get;
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
    assert.ok(!map.has("OraclePublicController_getTiers"));
    assert.ok(!map.has("OraclePublicController_getReconstitutions"));
  });

  it("response schemas are fully resolved", () => {
    const map = buildResponseSchemaMap(MOCK_SPEC as any);
    const basketSchema = map.get("OraclePublicController_getBasket")!;
    assert.ok(basketSchema);
    const props = basketSchema.properties as Record<string, any>;
    const items = props.models.items;
    // Should be resolved, not a $ref
    assert.equal(items.type, "object");
    assert.ok(!("$ref" in items));
  });
});

describe("getAllOracleToolSchemas (mocked fetch)", () => {
  let fetchMock: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    _resetCache();
    fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => MOCK_SPEC,
    }));
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("returns schemas for all oracle-backed tools", async () => {
    const schemas = await getAllOracleToolSchemas();
    assert.ok("data_get_basket" in schemas);
    assert.ok("data_get_price" in schemas);
    assert.ok("data_get_scu" in schemas);
    assert.ok("data_get_cpi" in schemas);
    assert.ok("data_get_tiers" in schemas);
    assert.ok("data_get_reconstitutions" in schemas);
    // Should NOT contain local tools
    assert.ok(!("compute_estimate" in schemas));
    assert.ok(!("render_session_report" in schemas));
  });

  it("data_get_price schema has model property with required", async () => {
    const schemas = await getAllOracleToolSchemas();
    const priceSchema = schemas.data_get_price;
    assert.ok(priceSchema);
    const props = priceSchema.properties as Record<string, unknown>;
    assert.ok("model" in props);
    assert.ok(Array.isArray(priceSchema.required));
    assert.ok((priceSchema.required as string[]).includes("model"));
  });

  it("data_get_reconstitutions has MCP-only limit property", async () => {
    const schemas = await getAllOracleToolSchemas();
    const reconSchema = schemas.data_get_reconstitutions;
    const props = reconSchema.properties as Record<string, Record<string, unknown>>;
    assert.ok("limit" in props);
    assert.equal(props.limit.type, "number");
  });

  it("falls back to hardcoded schemas when fetch fails", async () => {
    (globalThis as any).fetch = mock.fn(async () => { throw new Error("network down"); });
    const schemas = await getAllOracleToolSchemas();
    // Should still return schemas from FALLBACK_SCHEMAS
    assert.ok("data_get_basket" in schemas);
    assert.ok("data_get_price" in schemas);
    const priceSchema = schemas.data_get_price;
    assert.ok(Array.isArray(priceSchema.required));
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

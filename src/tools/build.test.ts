import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildTools } from "./build.js";
import { toolDefinitions } from "./definitions.js";
import { TOOL_TO_OPERATION, _resetCache } from "../oracle/openapi-schema.js";

const HANDLER_ARGS: Record<string, { required?: string[]; optional?: string[] }> = {
  data_get_basket: {},
  data_get_price: { required: ["model"] },
  data_get_scu: {},
  data_get_breakdown: {},
  data_get_cpi: {},
  data_get_reconstitutions: { optional: ["limit"] },
  data_get_methodology: {},
  data_get_history: { optional: ["from", "to", "granularity", "limit"] },
  data_get_model_price_history: {
    required: ["model"],
    optional: ["from", "to", "granularity", "limit"],
  },
  data_get_catalog: {},
  data_get_model_price_at: { required: ["model", "date"] },
  data_get_baseline: {},
  data_get_scu_at: { required: ["date"] },
  compute_estimate: { required: ["model", "input_tokens", "output_tokens"] },
  compute_compare: { required: ["input_tokens", "output_tokens"] },
  render_session_report: { optional: ["session_id", "cwd"] },
  render_consumption_report: { optional: ["session_id", "cwd", "full"] },
  render_active_sessions: { optional: ["cwd", "limit", "hours"] },
  analyze_session: { optional: ["session_id", "cwd"] },
  analyze_inferences: { optional: ["session_id", "cwd"] },
  telemetry_get_history: {},
};

const RESPONSE_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
};

function parameterlessSpec(): unknown {
  const paths: Record<string, unknown> = {};
  for (const operationId of new Set(Object.values(TOOL_TO_OPERATION))) {
    paths[`/v1/oracle/${operationId}`] = {
      get: {
        operationId,
        parameters: [],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: RESPONSE_SCHEMA } },
          },
        },
      },
    };
  }
  return { paths };
}

let originalFetch: typeof globalThis.fetch;

function serveSpec(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

describe("buildTools", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    _resetCache();
    serveSpec(parameterlessSpec());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetCache();
  });

  it("SHOULD advertise every argument its handler reads, with the handler's required set — Bug guarded: an oracle operation that documents no parameters must not strip model/date off the advertised tool", async () => {
    const tools = await buildTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      Object.keys(HANDLER_ARGS).sort(),
      "every tool must be pinned here",
    );

    for (const tool of tools) {
      const expected = HANDLER_ARGS[tool.name];
      const required = expected.required ?? [];
      const declared = Object.keys(
        (tool.inputSchema.properties ?? {}) as Record<string, unknown>,
      );
      assert.deepEqual(
        declared.sort(),
        [...required, ...(expected.optional ?? [])].sort(),
        `${tool.name} properties`,
      );
      assert.deepEqual(
        ((tool.inputSchema.required ?? []) as string[]).slice().sort(),
        required.slice().sort(),
        `${tool.name} required`,
      );
    }
  });

  it("SHOULD keep the advertised input schemas identical WHEN the OpenAPI document is unreachable — Bug guarded: a boot-time network failure must not change what agents may pass", async () => {
    const before = structuredClone(
      Object.fromEntries(toolDefinitions.map((d) => [d.name, d.inputSchema])),
    );
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof globalThis.fetch;
    const tools = await buildTools();
    for (const tool of tools) {
      assert.deepEqual(tool.inputSchema, before[tool.name], tool.name);
    }
  });

  it("SHOULD advertise the three granularity literals on every tool that buckets a series — Bug guarded: an unlisted granularity is a 422 from the oracle", async () => {
    const tools = await buildTools();
    for (const name of ["data_get_history", "data_get_model_price_history"]) {
      const properties = tools.find((t) => t.name === name)?.inputSchema.properties as
        | Record<string, { enum?: string[] }>
        | undefined;
      assert.deepEqual(
        properties?.granularity?.enum,
        ["per-revision", "daily", "weekly"],
        name,
      );
    }
  });

  it("SHOULD map oracle operations onto tools that exist — Bug guarded: a renamed tool would silently lose its response-schema documentation", () => {
    const names = new Set(toolDefinitions.map((t) => t.name));
    assert.deepEqual(
      Object.keys(TOOL_TO_OPERATION).filter((tool) => !names.has(tool)),
      [],
    );
  });

  it("SHOULD append the derived oracle response schema ONLY to tools whose output is not adapted", async () => {
    const tools = await buildTools();
    const scu = tools.find((t) => t.name === "data_get_scu");
    const basket = tools.find((t) => t.name === "data_get_basket");
    assert.ok(scu?.description.includes(JSON.stringify(RESPONSE_SCHEMA)));
    assert.ok(!basket?.description.includes(JSON.stringify(RESPONSE_SCHEMA)));
  });
});

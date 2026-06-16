/**
 * OpenAPI-derived MCP tool inputSchema
 *
 * Fetches the Oracle's OpenAPI spec at startup (with TTL-based cache) and
 * derives MCP tool inputSchema objects from operationId parameters. This
 * ensures the MCP tool schemas stay in sync with the Oracle API without
 * manual maintenance.
 *
 * Refresh strategy: boot-time fetch + cached with 1-hour TTL.
 * Failure mode: when the Oracle is unreachable, falls back to hardcoded
 * defaults so the MCP server always starts.
 *
 * @module
 */

const API_BASE = process.env.CF_API_BASE ?? "https://api.compute.finance";
const OPENAPI_URL = `${API_BASE}/openapi.json`;
// TTL enables re-use outside the one-shot MCP boot path (e.g. health-check,
// future CLI consumers). index.ts intentionally resolves once at startup.
const CACHE_TTL_MS = 3_600_000; // 1 hour

// ── Types ────────────────────────────────────────────────────────────

interface OpenApiParameter {
  name: string;
  required?: boolean;
  in: "path" | "query" | "header" | "cookie";
  schema?: Record<string, unknown>;
  description?: string;
}

interface OpenApiResponse {
  description?: string;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

interface OpenApiOperation {
  operationId?: string;
  parameters?: OpenApiParameter[];
  responses?: Record<string, OpenApiResponse>;
  summary?: string;
}

interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  delete?: OpenApiOperation;
  patch?: OpenApiOperation;
}

interface OpenApiSpec {
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, Record<string, unknown>>;
  };
}

type JsonSchema = Record<string, unknown>;

// ── Cache ────────────────────────────────────────────────────────────

interface CacheEntry {
  spec: OpenApiSpec;
  schemas: Map<string, JsonSchema>;
  responseSchemas: Map<string, JsonSchema>;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

// ── Mapping: MCP tool name -> OpenAPI operationId ────────────────────
//
// Only oracle-backed tools are listed here. Local compute/render/analysis
// tools have no oracle endpoint and keep their hardcoded schemas.

const TOOL_TO_OPERATION: Record<string, string> = {
  data_get_basket: "OraclePublicController_getBasket",
  data_get_price: "OraclePublicController_getModel",
  data_get_scu: "OraclePublicController_getScu",
  data_get_breakdown: "OraclePublicController_getScu",
  data_get_cpi: "OraclePublicController_getBasket",
  data_get_reconstitutions: "OraclePublicController_getReconstitutions",
  data_get_methodology: "MethodologyPublicController_getChangelog",
};

// Used when the OpenAPI spec is unreachable; frozen as a safety net.
export const FALLBACK_SCHEMAS: Record<string, JsonSchema> = {
  data_get_basket: { type: "object", properties: {} },
  data_get_price: {
    type: "object",
    properties: {
      model: { type: "string", description: "Model name", examples: ["claude-sonnet-4.6"] },
    },
    required: ["model"],
  },
  data_get_scu: { type: "object", properties: {} },
  data_get_breakdown: { type: "object", properties: {} },
  data_get_cpi: { type: "object", properties: {} },
  data_get_methodology: { type: "object", properties: {} },
  data_get_reconstitutions: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max events to return (most recent first). Defaults to all.",
        examples: [5],
      },
    },
  },
};

// ── Schema derivation ────────────────────────────────────────────────

/** Resolve a `$ref` string like `#/components/schemas/Foo` against the spec. */
function resolveRef(spec: OpenApiSpec, ref: string): Record<string, unknown> | null {
  const parts = ref.replace(/^#\//, "").split("/");
  let current: unknown = spec;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "object" && current !== null
    ? (current as Record<string, unknown>)
    : null;
}

/** Resolve a schema object, following `$ref` if present. */
function resolveSchema(
  spec: OpenApiSpec,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return { type: "string" };
  if (typeof schema.$ref === "string") {
    return resolveRef(spec, schema.$ref) ?? { type: "string" };
  }
  return schema;
}

/** Recursively resolve all $ref pointers in a schema so the result is self-contained. */
function deepResolveSchema(
  spec: OpenApiSpec,
  schema: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 8) return schema;

  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(spec, schema.$ref);
    return resolved ? deepResolveSchema(spec, resolved, depth + 1) : schema;
  }

  const result: Record<string, unknown> = { ...schema };

  if (result.properties && typeof result.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result.properties as Record<string, unknown>)) {
      props[k] =
        typeof v === "object" && v !== null
          ? deepResolveSchema(spec, v as Record<string, unknown>, depth + 1)
          : v;
    }
    result.properties = props;
  }

  if (result.items && typeof result.items === "object") {
    result.items = deepResolveSchema(
      spec,
      result.items as Record<string, unknown>,
      depth + 1,
    );
  }

  if (
    result.additionalProperties &&
    typeof result.additionalProperties === "object"
  ) {
    result.additionalProperties = deepResolveSchema(
      spec,
      result.additionalProperties as Record<string, unknown>,
      depth + 1,
    );
  }

  return result;
}

/** Extract the 200-response JSON Schema from an operation, fully resolved. */
function extractResponseSchema(
  spec: OpenApiSpec,
  operation: OpenApiOperation,
): JsonSchema | null {
  const resp200 = operation.responses?.["200"] ?? operation.responses?.["201"];
  if (!resp200) return null;
  const jsonContent = resp200.content?.["application/json"];
  if (!jsonContent?.schema) return null;
  return deepResolveSchema(spec, jsonContent.schema);
}

/**
 * Build an MCP-compatible inputSchema (JSON Schema) from an OpenAPI
 * operation's parameters array.
 *
 * - Path and query parameters become top-level properties.
 * - Required path parameters are marked as required.
 * - Header/cookie parameters are excluded (not relevant for MCP).
 */
function buildInputSchema(
  spec: OpenApiSpec,
  operation: OpenApiOperation,
): JsonSchema {
  const params = (operation.parameters ?? []).filter(
    (p) => p.in === "path" || p.in === "query",
  );

  if (params.length === 0) {
    return { type: "object", properties: {} };
  }

  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const param of params) {
    const resolved = resolveSchema(spec, param.schema as Record<string, unknown> | undefined);
    const prop: Record<string, unknown> = { ...resolved };
    if (param.description) {
      prop.description = param.description;
    }
    // For the MCP `data_get_price` tool, the path param is named `key` in the
    // OpenAPI spec but the MCP handler expects `model`. We remap below.
    properties[param.name] = prop;
    if (param.required) {
      required.push(param.name);
    }
  }

  const schema: JsonSchema = { type: "object", properties };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

// ── Parameter name remapping ─────────────────────────────────────────
//
// The OpenAPI spec names the path parameter `key` for `/v1/oracle/model/{key}`,
// but the MCP tool handler expects `model`. This map handles that translation.

const PARAM_RENAMES: Record<string, Record<string, string>> = {
  data_get_price: { key: "model" },
};

/** Apply per-tool parameter renames to a derived schema. */
function applyRenames(toolName: string, schema: JsonSchema): JsonSchema {
  const renames = PARAM_RENAMES[toolName];
  if (!renames) return schema;

  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props) return schema;

  const newProps: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    const renamed = renames[name] ?? name;
    newProps[renamed] = value;
  }

  const req = schema.required as string[] | undefined;
  const newReq = req?.map((r) => renames[r] ?? r);

  return {
    ...schema,
    properties: newProps,
    ...(newReq && newReq.length > 0 ? { required: newReq } : {}),
  };
}

// ── MCP-specific schema overrides ────────────────────────────────────
//
// Some MCP tools add parameters that don't exist in the OpenAPI spec
// (e.g. `data_get_reconstitutions` adds a `limit` param that's enforced
// client-side, not by the Oracle). These are merged on top of the
// OpenAPI-derived schema.

const MCP_EXTRA_PROPERTIES: Record<string, Record<string, Record<string, unknown>>> = {
  data_get_reconstitutions: {
    limit: {
      type: "number",
      description: "Max events to return (most recent first). Defaults to all.",
      examples: [5],
    },
  },
  data_get_price: {
    model: {
      type: "string",
      description: "Model name",
      examples: ["claude-sonnet-4.6"],
    },
  },
};

/** Merge MCP-only extra properties into a derived schema (per-property merge). */
function applyMcpExtras(toolName: string, schema: JsonSchema): JsonSchema {
  const extras = MCP_EXTRA_PROPERTIES[toolName];
  if (!extras) return schema;

  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const merged: Record<string, unknown> = { ...props };
  for (const [key, extra] of Object.entries(extras)) {
    merged[key] = { ...(props[key] ?? {}), ...extra };
  }
  return { ...schema, properties: merged };
}

// ── Core functions ───────────────────────────────────────────────────

/** Build the operationId -> inputSchema map from a parsed OpenAPI spec. */
function buildSchemaMap(spec: OpenApiSpec): Map<string, JsonSchema> {
  const map = new Map<string, JsonSchema>();

  for (const [, pathItem] of Object.entries(spec.paths)) {
    for (const method of ["get", "post", "put", "delete", "patch"] as const) {
      const operation = pathItem[method];
      if (!operation?.operationId) continue;
      map.set(operation.operationId, buildInputSchema(spec, operation));
    }
  }

  return map;
}

/** Build the operationId -> response JSON Schema map from a parsed OpenAPI spec. */
function buildResponseSchemaMap(spec: OpenApiSpec): Map<string, JsonSchema> {
  const map = new Map<string, JsonSchema>();

  for (const [, pathItem] of Object.entries(spec.paths)) {
    for (const method of ["get", "post", "put", "delete", "patch"] as const) {
      const operation = pathItem[method];
      if (!operation?.operationId) continue;
      const schema = extractResponseSchema(spec, operation);
      if (schema) map.set(operation.operationId, schema);
    }
  }

  return map;
}

/**
 * Fetch the OpenAPI spec and build the schema map.
 * Returns null on network/parse failure.
 */
async function fetchAndBuild(): Promise<CacheEntry | null> {
  try {
    const res = await fetch(OPENAPI_URL, {
      signal: AbortSignal.timeout(10_000), // 10s timeout
    });
    if (!res.ok) return null;
    const spec = (await res.json()) as OpenApiSpec;
    if (!spec.paths || typeof spec.paths !== "object") return null;
    const schemas = buildSchemaMap(spec);
    const responseSchemas = buildResponseSchemaMap(spec);
    return { spec, schemas, responseSchemas, fetchedAt: Date.now() };
  } catch {
    return null;
  }
}

async function ensureCache(): Promise<CacheEntry | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }
  const entry = await fetchAndBuild();
  if (entry) {
    cache = entry;
    return entry;
  }
  return cache ?? null;
}

async function getSchemaMap(): Promise<Map<string, JsonSchema> | null> {
  const entry = await ensureCache();
  return entry?.schemas ?? null;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Get the inputSchema for a single MCP tool by its tool name.
 *
 * Resolution order:
 * 1. OpenAPI spec (via operationId mapping) + parameter renames + MCP extras
 * 2. Hardcoded fallback if OpenAPI is unavailable
 * 3. Empty object schema as last resort
 */
export async function getToolInputSchema(toolName: string): Promise<JsonSchema> {
  const operationId = TOOL_TO_OPERATION[toolName];
  if (!operationId) {
    // Not an oracle-backed tool — no OpenAPI mapping exists.
    // Return fallback if we have one, otherwise empty.
    return FALLBACK_SCHEMAS[toolName] ?? { type: "object", properties: {} };
  }

  const schemas = await getSchemaMap();
  if (!schemas) {
    return FALLBACK_SCHEMAS[toolName] ?? { type: "object", properties: {} };
  }

  const raw = schemas.get(operationId);
  if (!raw) {
    return FALLBACK_SCHEMAS[toolName] ?? { type: "object", properties: {} };
  }

  // Apply renames (e.g. key -> model), then merge MCP-only extras
  const renamed = applyRenames(toolName, raw);
  return applyMcpExtras(toolName, renamed);
}

/**
 * Get inputSchemas for all oracle-backed MCP tools in one call.
 * More efficient than calling getToolInputSchema() per tool — single
 * OpenAPI fetch for all.
 *
 * Returns a map from tool name -> inputSchema.
 */
export async function getAllOracleToolSchemas(): Promise<Record<string, JsonSchema>> {
  const schemas = await getSchemaMap();
  const result: Record<string, JsonSchema> = {};

  for (const [toolName, operationId] of Object.entries(TOOL_TO_OPERATION)) {
    if (schemas) {
      const raw = schemas.get(operationId);
      if (raw) {
        const renamed = applyRenames(toolName, raw);
        result[toolName] = applyMcpExtras(toolName, renamed);
        continue;
      }
    }
    // Fallback
    result[toolName] = FALLBACK_SCHEMAS[toolName] ?? { type: "object", properties: {} };
  }

  return result;
}

/**
 * Pre-warm the OpenAPI cache. Call at startup so the first
 * ListTools request doesn't block on a network fetch.
 * Silently swallows errors — fallback schemas will be used.
 */
export async function warmOpenApiCache(): Promise<void> {
  await getSchemaMap();
}

/**
 * Get response schemas for all oracle-backed MCP tools in one call.
 * Returns a map from tool name -> fully-resolved response JSON Schema.
 * Tools whose Oracle endpoint has no documented response schema are omitted.
 */
export async function getAllOracleToolResponseSchemas(): Promise<Record<string, JsonSchema>> {
  const entry = await ensureCache();
  const responseMap = entry?.responseSchemas;
  const result: Record<string, JsonSchema> = {};

  if (!responseMap) return result;

  for (const [toolName, operationId] of Object.entries(TOOL_TO_OPERATION)) {
    const schema = responseMap.get(operationId);
    if (schema) result[toolName] = schema;
  }

  return result;
}

/**
 * Check whether a tool name has an Oracle-backed schema mapping.
 */
export function isOracleBackedTool(toolName: string): boolean {
  return toolName in TOOL_TO_OPERATION;
}

// ── Testing helpers ──────────────────────────────────────────────────

/** @internal Reset the cache — for tests only. */
export function _resetCache(): void {
  cache = null;
}

/** @internal Expose internals for unit testing. */
export const _internals = {
  buildInputSchema,
  buildSchemaMap,
  buildResponseSchemaMap,
  deepResolveSchema,
  extractResponseSchema,
  resolveRef,
  applyRenames,
  applyMcpExtras,
  TOOL_TO_OPERATION,
  FALLBACK_SCHEMAS,
  PARAM_RENAMES,
};

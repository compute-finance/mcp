const API_BASE = process.env.CF_API_BASE ?? "https://api.compute.finance";
const OPENAPI_URL = `${API_BASE}/openapi.json`;
const CACHE_TTL_MS = 3_600_000;

export const TOOL_TO_OPERATION: Record<string, string> = {
  data_get_basket: "OraclePublicController_getBasket",
  data_get_price: "OraclePublicController_getModel",
  data_get_scu: "OraclePublicController_getScu",
  data_get_breakdown: "OraclePublicController_getScu",
  data_get_cpi: "OraclePublicController_getBasket",
  data_get_reconstitutions: "OraclePublicController_getReconstitutions",
  data_get_methodology: "MethodologyPublicController_getChangelog",
  data_get_history: "OraclePublicController_getHistory",
  data_get_model_price_history: "OraclePublicController_getModelPriceHistory",
  data_get_catalog: "OraclePublicController_getCatalog",
  data_get_model_price_at: "OraclePublicController_getModelPriceAt",
  data_get_baseline: "OraclePublicController_getBaseline",
  data_get_scu_at: "OraclePublicController_getScuAt",
};

interface OpenApiResponse {
  description?: string;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

interface OpenApiOperation {
  operationId?: string;
  responses?: Record<string, OpenApiResponse>;
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

interface CacheEntry {
  responseSchemas: Map<string, JsonSchema>;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

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

async function fetchAndBuild(): Promise<CacheEntry | null> {
  try {
    const res = await fetch(OPENAPI_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const spec = (await res.json()) as OpenApiSpec;
    if (!spec.paths || typeof spec.paths !== "object") return null;
    return { responseSchemas: buildResponseSchemaMap(spec), fetchedAt: Date.now() };
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

export async function warmOpenApiCache(): Promise<void> {
  await ensureCache();
}

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

export function _resetCache(): void {
  cache = null;
}

export const _internals = {
  buildResponseSchemaMap,
  deepResolveSchema,
  extractResponseSchema,
  resolveRef,
};

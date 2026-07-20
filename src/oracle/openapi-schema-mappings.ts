type JsonSchema = Record<string, unknown>;

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

/** Used when the OpenAPI spec is unreachable; frozen as a safety net. */
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
  data_get_history: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description: "ISO 8601 start of range (inclusive). Defaults to genesis.",
        examples: ["2026-04-01T00:00:00Z"],
      },
      to: {
        type: "string",
        description: "ISO 8601 end of range (inclusive). Defaults to now.",
        examples: ["2026-06-01T00:00:00Z"],
      },
      granularity: {
        type: "string",
        enum: ["per-revision", "daily", "weekly"],
        description:
          "Bucketing granularity. per-revision emits one point per revision; daily/weekly buckets carry the last revision's value forward across empty buckets (step-function close). Defaults to per-revision.",
      },
      limit: {
        type: "number",
        description:
          "Max points (cap 10000). Oldest are dropped first when capped; the response sets truncated: true.",
      },
    },
  },
  data_get_model_price_history: {
    type: "object",
    properties: {
      model: {
        type: "string",
        description:
          "Model pricing key (e.g. 'gpt-5.5'). Models that have never appeared in any confirmed revision return an error.",
        examples: ["gpt-5.5"],
      },
      from: {
        type: "string",
        description: "ISO 8601 start of range (inclusive). Defaults to genesis.",
        examples: ["2026-04-01T00:00:00Z"],
      },
      to: {
        type: "string",
        description: "ISO 8601 end of range (inclusive). Defaults to now.",
        examples: ["2026-06-01T00:00:00Z"],
      },
      granularity: {
        type: "string",
        enum: ["per-revision", "daily", "weekly"],
        description:
          "Bucketing granularity. per-revision emits one point per revision the model appeared in; daily/weekly carry forward. Defaults to per-revision.",
      },
      limit: {
        type: "number",
        description: "Max points (cap 10000). Oldest are dropped first when capped.",
      },
    },
    required: ["model"],
  },
  data_get_catalog: { type: "object", properties: {} },
  data_get_baseline: { type: "object", properties: {} },
  data_get_model_price_at: {
    type: "object",
    properties: {
      model: {
        type: "string",
        description:
          "Model pricing key (e.g. 'gpt-5.5'). Returns the price effective at the requested timestamp.",
        examples: ["gpt-5.5"],
      },
      date: {
        type: "string",
        description:
          "ISO 8601 timestamp (e.g. '2026-06-15T12:00:00Z'). Must not be in the future.",
        examples: ["2026-06-15T12:00:00Z"],
      },
    },
    required: ["model", "date"],
  },
  data_get_scu_at: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description:
          "ISO 8601 timestamp (e.g. '2026-06-15T12:00:00Z'). Must not be in the future. Returns null when the timestamp precedes the genesis revision.",
        examples: ["2026-06-15T12:00:00Z"],
      },
    },
    required: ["date"],
  },
};

export const PARAM_RENAMES: Record<string, Record<string, string>> = {
  data_get_price: { key: "model" },
  data_get_model_price_history: { key: "model" },
  data_get_model_price_at: { key: "model" },
};

export const MCP_EXTRA_PROPERTIES: Record<
  string,
  Record<string, Record<string, unknown>>
> = {
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
  data_get_model_price_history: {
    model: {
      type: "string",
      description: "Model pricing key (e.g. 'gpt-5.5').",
      examples: ["gpt-5.5"],
    },
  },
};

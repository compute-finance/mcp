import { FALLBACK_SCHEMAS } from "../oracle/openapi-schema.js";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

const ORACLE: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const RENDER: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const LOCAL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const toolDefinitions: ToolDef[] = [
  {
    name: "data_get_basket",
    description:
      "All models in the oracle basket — provider, family (e.g. openai.gpt, anthropic.claude, google.gemini, xai.grok), input/output USD and wei prices per million tokens, and per-component cache pricing (cachedInput, cacheWrite5m, cacheWrite1h) with provider attribution. Source: Oracle API. Use for the full pricing picture. For a single model, use data_get_price instead.",
    inputSchema: FALLBACK_SCHEMAS.data_get_basket,
    annotations: ORACLE,
  },
  {
    name: "data_get_price",
    description:
      "Price for a single model — input/output USD and wei per million tokens, plus per-component cache pricing (cachedInput, cacheWrite5m, cacheWrite1h) with provider attribution. Source: Oracle API. Use for one model; for comparing all models use compute_compare. Accepts canonical names like 'claude-opus-4.7' or 'gpt-5.5'.",
    inputSchema: FALLBACK_SCHEMAS.data_get_price,
    annotations: ORACLE,
  },
  {
    name: "data_get_scu",
    description:
      "Current Standard Compute Unit (SCU) — value plus the methodology-versioned `breakdown` discriminated union listing every family representative with USD-per-million-token prices and blended cost. The response carries methodologyVersion; see data_get_methodology for the formula in force. For the breakdown alone, use data_get_breakdown. Source: Oracle API.",
    inputSchema: FALLBACK_SCHEMAS.data_get_scu,
    annotations: ORACLE,
  },
  {
    name: "data_get_breakdown",
    description:
      "Per-family blended-cost breakdown of the SCU — methodology-versioned discriminated union (keyed by methodologyVersion) with one entry per family representative (family, modelKey, inputPriceUsdPerMillion, outputPriceUsdPerMillion, blendedCostUsd). Source: Oracle API (/v1/oracle/scu.breakdown). Use to attribute SCU contributions to specific model families. For the full SCU response with reference workload, use data_get_scu instead.",
    inputSchema: FALLBACK_SCHEMAS.data_get_breakdown,
    annotations: ORACLE,
  },
  {
    name: "data_get_cpi",
    description:
      "Full Compute Price Index — raw oracle response with provider, family, integration flag, raw and marked-up prices, scuUsd, basket version, last-updated timestamp. Source: Oracle API. Use data_get_basket for a cleaner view focused on pricing; use this for the complete index data. For the per-family blended-cost breakdown, use data_get_breakdown.",
    inputSchema: FALLBACK_SCHEMAS.data_get_cpi,
    annotations: ORACLE,
  },
  {
    name: "data_get_reconstitutions",
    description:
      "Historical basket changes — model swaps with date, basket version, models added/removed, SCU before/after. Source: Oracle API. Sorted most recent first. Use the optional limit parameter to cap results.",
    inputSchema: FALLBACK_SCHEMAS.data_get_reconstitutions,
    annotations: ORACLE,
  },
  {
    name: "data_get_methodology",
    description:
      "Methodology changelog — every registered methodology version with its formula summary, family rule, reference workload, and spec reference, plus activeVersion (the version in force now). Source: Oracle API. Use to interpret SCU values and to pin integrations to a methodology version.",
    inputSchema: FALLBACK_SCHEMAS.data_get_methodology,
    annotations: ORACLE,
  },

  {
    name: "compute_estimate",
    description:
      "Nominal USD cost for a model given input/output token counts (no cache discounts). Source: Oracle API. For cache-aware cost, use analyze_session on a real transcript. Accepts canonical names like 'claude-sonnet-4.6'.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", examples: ["claude-sonnet-4.6"] },
        input_tokens: { type: "number", examples: [50000] },
        output_tokens: { type: "number", examples: [5000] },
      },
      required: ["model", "input_tokens", "output_tokens"],
    },
    annotations: ORACLE,
  },
  {
    name: "compute_compare",
    description:
      "Rank all basket models by nominal cost for a workload. Source: Oracle API. Returns a sorted list of per-model USD cost plus a grouping by family (e.g. openai.gpt, anthropic.claude). Use to answer 'which model is cheapest?' or 'how much would this cost on a different model?'.",
    inputSchema: {
      type: "object",
      properties: {
        input_tokens: { type: "number", examples: [50000] },
        output_tokens: { type: "number", examples: [5000] },
      },
      required: ["input_tokens", "output_tokens"],
    },
    annotations: ORACLE,
  },

  {
    name: "render_session_report",
    description:
      "Pre-formatted session cost report for cf-session-management skill. Source: local Claude Code transcript + Oracle API. Reads the transcript, prices it, logs to history, returns a `text` string. Header carries the canonical Prompts · Inferences · Tool calls triplet (user prompts, assistant replies, tool_use blocks — three distinct counters). Print verbatim — do not reformat or interpret. Omit session_id for the most recent session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        cwd: { type: "string" },
      },
    },
    annotations: RENDER,
  },
  {
    name: "render_consumption_report",
    description:
      "Pre-formatted per-inference breakdown for cf-session-consumption skill. Source: local Claude Code transcript + Oracle API. Bar chart, tool aggregates, mechanical facts; one row per assistant reply (Innn). Header carries the canonical Prompts · Inferences · Tool calls triplet — same numbers as render_session_report and render_active_sessions. Print the `text` field verbatim. Pass full=true to show every inference instead of top-10/last-5.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        cwd: { type: "string" },
        full: {
          type: "boolean",
          description:
            "If true, show every inference (no top-10/last-5 truncation). Default false.",
        },
      },
    },
    annotations: RENDER,
  },
  {
    name: "render_active_sessions",
    description:
      "Pre-formatted table of recent Claude Code sessions across all projects — per-session Prompts · Inferences · Tool calls, tokens, and effective/nominal cost. Source: local Claude Code transcripts + Oracle API. Print the `text` field verbatim. Defaults to last 24h, top 10.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Limit to sessions from this working directory.",
        },
        limit: { type: "number", description: "Max rows (default 10)." },
        hours: {
          type: "number",
          description: "Look-back window in hours (default 24).",
        },
      },
    },
    annotations: RENDER,
  },

  {
    name: "analyze_session",
    description:
      "Raw JSON session analysis — token totals, effective/nominal cost with cache breakdown, counterfactual across all basket models, profile classification. `usage.prompts` counts user messages, `usage.inferences` counts assistant replies, `usage.tool_calls` counts tool_use blocks. `current_model_cost.effective_usd` is `null` when the oracle has not published cache pricing for the model; `nominal_usd` stays populated as an upper-bound. Source: local Claude Code transcript + Oracle API. For pre-formatted output use render_session_report. Omit session_id for the most recent session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        cwd: { type: "string" },
      },
    },
    annotations: RENDER,
  },
  {
    name: "analyze_inferences",
    description:
      "Raw JSON per-inference breakdown — token counts, tool usage, effective/nominal cost, cache hit ratio, duration per inference. One row per assistant reply. `inferences[].effective_usd` is `null` when the oracle has not published cache pricing for the model; `nominal_usd` stays populated as an upper-bound. Source: local Claude Code transcript + Oracle API. For pre-formatted output use render_consumption_report. Omit session_id for the most recent session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        cwd: { type: "string" },
      },
    },
    annotations: RENDER,
  },

  {
    name: "telemetry_get_history",
    description:
      "Aggregate stats across logged sessions (deduped, last-wins). Source: local ~/.compute-finance/ storage + Oracle API. Sample size, cumulative effective vs nominal cost, per-profile medians, insights (cache dominance). Insights require at least 5 sessions.",
    inputSchema: { type: "object", properties: {} },
    annotations: { ...LOCAL, openWorldHint: true },
  },
];

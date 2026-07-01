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
      "Current Standard Compute Unit (SCU) — value plus the methodology-versioned `breakdown` discriminated union listing every family representative with USD-per-million-token prices and blended cost. Also carries `computeIndex`: the inverse purchasing-power view (baseline / scuUsd) × 100, anchored at 100 at the first confirmed revision. The response carries methodologyVersion; see data_get_methodology for the formula in force. For the breakdown alone, use data_get_breakdown; for the baseline denominator, use data_get_baseline. Source: Oracle API.",
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
    name: "data_get_history",
    description:
      "SCU index time series — date-range history of Standard Compute Unit values with optional bucketing granularity. Source: Oracle API (/v1/oracle/history). Each point carries scuUsd, methodologyVersion, revisionVersion, metadataHash, and computeIndex when populated. per-revision emits one point per revision; daily and weekly buckets carry the last revision's value forward across empty buckets (step-function close). Defaults to per-revision over the full range. For a single point at a specific timestamp, fetch the individual revision via data_get_cpi.",
    inputSchema: FALLBACK_SCHEMAS.data_get_history,
    annotations: ORACLE,
  },
  {
    name: "data_get_model_price_history",
    description:
      "Per-model input/output USD price time series — date-range history for a single model that has appeared in at least one confirmed SCU basket. Source: Oracle API (/v1/oracle/models/{model}/price-history). Each point carries input/output USD per million tokens plus revisionVersion, methodologyVersion and metadataHash. Catchup revisions whose manifest is unavailable are surfaced in unavailableRevisions. Same granularity (per-revision/daily/weekly) and limit semantics as data_get_history. Models that have never appeared in any confirmed revision return an error.",
    inputSchema: FALLBACK_SCHEMAS.data_get_model_price_history,
    annotations: ORACLE,
  },
  {
    name: "data_get_catalog",
    description:
      "Full catalog of tracked models — every model with a recorded price, including non-index entries. Source: Oracle API (/v1/oracle/catalog). Each entry carries modelKey, displayName, provider, family, indexMember flag (true if current family representative in the latest confirmed revision), currentPrice with input/output USD per million tokens and observedAt timestamp, and per-component cache/reasoning blocks. For basket-only display, use data_get_basket instead.",
    inputSchema: FALLBACK_SCHEMAS.data_get_catalog,
    annotations: ORACLE,
  },
  {
    name: "data_get_model_price_at",
    description:
      "Per-model input/output USD price effective at a specific timestamp. Source: Oracle API (/v1/oracle/models/{model}/price-at). Response is a discriminated union by source: 'manifest' when the model is the family representative in the revision active at that date (cross-links revisionVersion, methodologyVersion, metadataHash, family for verification), or 'providerCost' when only catalog pricing exists (step-function fallback). observedAt reflects when the price was recorded. Returns an error for malformed or future dates, untracked models, or dates preceding all available data.",
    inputSchema: FALLBACK_SCHEMAS.data_get_model_price_at,
    annotations: ORACLE,
  },
  {
    name: "data_get_baseline",
    description:
      "Frozen SCU denominator for the inverse computeIndex purchasing-power view: the SCU of the first confirmed revision (methodologyVersion 1), captured set-once and never changes. Source: Oracle API (/v1/oracle/baseline). The published computeIndex on /v1/oracle/scu, /v1/oracle/latest and each /v1/oracle/history point equals (baseline.scuUsd / point.scuUsd) × 100 — 100 at genesis, rises as compute gets cheaper. Returns null until the first revision is confirmed.",
    inputSchema: FALLBACK_SCHEMAS.data_get_baseline,
    annotations: ORACLE,
  },
  {
    name: "data_get_scu_at",
    description:
      "SCU value active at a specific timestamp via step function — no interpolation. Source: Oracle API (/v1/oracle/scu-at). Resolves the latest confirmed revision with publishedAt ≤ date and returns its scuUsd, scuUsd18, computeIndex, revisionVersion, methodologyVersion, publishedAt, and metadataHash. Monotonicity is non-strict — when two confirmed revisions share publishedAt the highest revisionVersion wins. computeIndex is derived as (baseline.scuUsd / scuUsd) × 100, the same formula as data_get_scu and each data_get_history point. Returns null when the date precedes the genesis revision; errors on malformed or future dates. Use data_get_history for a bucketed series; use data_get_scu_at for a single-point lookup.",
    inputSchema: FALLBACK_SCHEMAS.data_get_scu_at,
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

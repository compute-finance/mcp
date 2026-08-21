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
  adaptedOutput?: true;
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

const NO_ARGS = { type: "object", properties: {} };

const PROVENANCE_NOTE =
  "A `provenance` mark says how far a number has been checked: 'verified' — an operator recorded a vendor source; " +
  "'inferred' — derived from a sibling number or a vendor default, with no source recorded; " +
  "'promotional' — a discounted list price expected to end. " +
  "Every value bills exactly as shown: the mark rates trust in the number, not the amount charged, " +
  "and holds as of the operator's last pass rather than a live vendor check.";

export const toolDefinitions: ToolDef[] = [
  {
    name: "data_get_basket",
    description:
      "All models in the oracle basket — provider, family (e.g. openai.gpt, anthropic.claude, google.gemini, xai.grok), base_* USD and wei prices per million tokens (the provider list price), billed_* prices (what compute.finance charges), per-component cache pricing (cachedInput, cacheWrite5m, cacheWrite1h) and a `reasoning` block carrying `reasoningOutput` (the whole block is null when the model has no reasoning price), all priced on the same base. `routing_fee_rate` ships once at the top level; billed_* is null when the oracle does not publish it. Compare models on base_*; budget on billed_*. " +
      `${PROVENANCE_NOTE} Every cache and reasoning component carries one. A base price is marked exactly when it came from the catalogue, so base_*/billed_* carry no mark here — a basket entry's base_* are the attested manifest figures. data_get_price marks base_* for the same model whenever it serves catalogue numbers instead. ` +
      "Source: Oracle API. For a single model, use data_get_price instead.",
    inputSchema: NO_ARGS,
    annotations: ORACLE,
    adaptedOutput: true,
  },
  {
    name: "data_get_price",
    description:
      "Price for a single oracle-tracked model — basket members and catalog-only entries on identical terms. Returns base_input/base_output USD per million tokens (the provider list price), `routing_fee_rate`, and billed_* = base × (1 + routing_fee_rate) — what compute.finance charges. Wei prices are populated for basket members and null otherwise. Per-component cache pricing (cachedInput, cacheWrite5m, cacheWrite1h) and the `reasoning` block carrying `reasoningOutput` (the whole block is null when the model has no reasoning price) are on the base basis. Compare models on base_*: two models with the same provider price return the same numbers regardless of basket membership. " +
      `${PROVENANCE_NOTE} \`base_price_provenance\` carries one mark for base_input and one for base_output exactly when they are catalogue numbers, and is null when they are the attested manifest figures no mark describes — read the field, price_source does not decide it. Every cache and reasoning component carries its own mark either way. ` +
      "`price_source` ('oracle-basket' | 'oracle-catalog') names the serving endpoint only and does not change the pricing basis. Errors with 'Model not tracked by oracle' for unknown keys. Source: Oracle API (/v1/oracle/resolve + /v1/oracle/basket). Models are identified by their canonical vendor-prefixed id ('anthropic/claude-opus-4.8', 'openai/gpt-5.5'); the bare name ('gpt-5.5') resolves to the same model, and the response echoes the canonical id. The vendor slug is not always provider.key (alibaba → qwen, xai → x-ai, moonshot → moonshotai), so pass an id the API returned rather than assembling one.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Canonical vendor-prefixed model id (e.g. 'anthropic/claude-sonnet-4.6'); the bare name also resolves.",
          examples: ["anthropic/claude-sonnet-4.6"],
        },
      },
      required: ["model"],
    },
    annotations: ORACLE,
    adaptedOutput: true,
  },
  {
    name: "data_get_scu",
    description:
      "Current Standard Compute Unit (SCU) — value plus the methodology-versioned `breakdown` discriminated union listing every family representative with USD-per-million-token prices and blended cost. Also carries `computeIndex`: the inverse purchasing-power view (baseline / scuUsd) × 100, anchored at 100 at the first confirmed revision. The response carries methodologyVersion; see data_get_methodology for the formula in force. breakdown.familyRepresentatives[].modelKey is the bare manifest key ('claude-opus-4.8'), not the canonical vendor-prefixed id — strip the vendor prefix off a catalog modelKey before joining on it. For the breakdown alone, use data_get_breakdown; for the baseline denominator, use data_get_baseline. Source: Oracle API.",
    inputSchema: NO_ARGS,
    annotations: ORACLE,
  },
  {
    name: "data_get_breakdown",
    description:
      "Per-family blended-cost breakdown of the SCU — methodology-versioned discriminated union (keyed by methodologyVersion) with one entry per family representative (family, modelKey, inputPriceUsdPerMillion, outputPriceUsdPerMillion, blendedCostUsd). modelKey is the bare manifest key ('claude-opus-4.8'), not the canonical vendor-prefixed id — strip the vendor prefix off a catalog modelKey before joining on it. Source: Oracle API (/v1/oracle/scu.breakdown). Use to attribute SCU contributions to specific model families. For the full SCU response with reference workload, use data_get_scu instead.",
    inputSchema: NO_ARGS,
    annotations: ORACLE,
  },
  {
    name: "data_get_cpi",
    description:
      "Full Compute Price Index — raw oracle response with the canonical vendor-prefixed model id, provider, family, raw and marked-up prices, scuUsd, revisionVersion, last-updated timestamp. Source: Oracle API. Use data_get_basket for a cleaner view focused on pricing; use this for the complete index data. For the per-family blended-cost breakdown, use data_get_breakdown.",
    inputSchema: NO_ARGS,
    annotations: ORACLE,
  },
  {
    name: "data_get_reconstitutions",
    description:
      "Historical index changes — each entry carries publishedAt, revisionVersion, methodologyVersion, scuBefore/scuAfter, a summary and the attesting txHash, plus a typed changes[] list (MODEL_ADDED, MODEL_REMOVED, PRICE_CHANGE, WORKLOAD_CHANGE). changes[].modelKey is the bare manifest key ('claude-opus-4.8'), not the canonical vendor-prefixed id — strip the vendor prefix off a catalog modelKey before joining on it. Source: Oracle API. Sorted most recent first. Use the optional limit parameter to cap results.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max events to return (most recent first). Defaults to all.",
          examples: [5],
        },
      },
    },
    annotations: ORACLE,
  },
  {
    name: "data_get_methodology",
    description:
      "Methodology changelog — every registered methodology version with its formula summary, family rule, reference workload, and spec reference, plus activeVersion (the version in force now). Source: Oracle API. Use to interpret SCU values and to pin integrations to a methodology version.",
    inputSchema: NO_ARGS,
    annotations: ORACLE,
  },
  {
    name: "data_get_history",
    description:
      "SCU index time series — date-range history of Standard Compute Unit values with optional bucketing granularity. Source: Oracle API (/v1/oracle/history). Each point carries scuUsd, methodologyVersion, revisionVersion, metadataHash, and computeIndex when populated. per-revision emits one point per revision; daily and weekly buckets carry the last revision's value forward across empty buckets (step-function close). Defaults to per-revision over the full range. For a single point at a specific timestamp, fetch the individual revision via data_get_cpi.",
    inputSchema: {
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
    annotations: ORACLE,
  },
  {
    name: "data_get_model_price_history",
    description:
      "Per-model input/output USD price time series — date-range history for any oracle-tracked model. Source: Oracle API (/v1/oracle/models/{model}/price-history). Each point carries input/output USD per million tokens, a source ('manifest' | 'catalog'), plus revisionVersion, methodologyVersion and metadataHash on attested points. Catchup revisions whose manifest is unavailable are surfaced in unavailableRevisions. Same granularity (per-revision/daily/weekly) and limit semantics as data_get_history. The model is named by its canonical vendor-prefixed id ('anthropic/claude-opus-4.8'); the bare name ('claude-opus-4.8') names the same model. modelKey echoes the canonical id; manifestKey carries the bare key the attested manifest is keyed by and ships whenever at least one point has source 'manifest'. Errors only when the model has neither an attested appearance nor a catalog price.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Canonical vendor-prefixed model id (e.g. 'openai/gpt-5.5'); the bare name also resolves.",
          examples: ["openai/gpt-5.5"],
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
    annotations: ORACLE,
  },
  {
    name: "data_get_catalog",
    description:
      "Full catalog of tracked models — every model with a recorded price, including non-index entries. Source: Oracle API (/v1/oracle/catalog). Each entry carries modelKey (the canonical vendor-prefixed id, e.g. 'anthropic/claude-opus-4.8'), displayName, provider, family, indexMember flag (true if current family representative in the latest confirmed revision), currentPrice with input/output USD per million tokens and an observedAt timestamp, and per-component cache/reasoning blocks (`reasoning` is null when the model has no reasoning price). " +
      `${PROVENANCE_NOTE} currentPrice.provenance carries one mark per price for every model, index member or not, because these are catalogue rows rather than manifest figures; every cache and reasoning component carries its own. ` +
      "For basket-only display, use data_get_basket instead.",
    inputSchema: NO_ARGS,
    annotations: ORACLE,
  },
  {
    name: "data_get_model_price_at",
    description:
      "Per-model input/output USD price effective at a specific timestamp. Source: Oracle API (/v1/oracle/models/{model}/price-at). Response is a discriminated union by source: 'manifest' when the model is the family representative in the revision active at that date (cross-links revisionVersion, methodologyVersion, metadataHash, family for verification), or 'catalog' when only catalog pricing exists (step-function fallback). The model is named by its canonical vendor-prefixed id ('anthropic/claude-opus-4.8'); the bare name ('claude-opus-4.8') names the same model. modelKey echoes the canonical id; manifestKey carries the bare key the attested manifest is keyed by and ships with every 'manifest' response. observedAt reflects when the price was recorded. Returns an error for malformed or future dates, untracked models, or dates preceding all available data.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Canonical vendor-prefixed model id (e.g. 'openai/gpt-5.5'); the bare name also resolves. Returns the price effective at the requested timestamp.",
          examples: ["openai/gpt-5.5"],
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
    annotations: ORACLE,
  },
  {
    name: "data_get_baseline",
    description:
      "Frozen SCU denominator for the inverse computeIndex purchasing-power view: the SCU of the first confirmed revision (methodologyVersion 1), captured set-once and never changes. Source: Oracle API (/v1/oracle/baseline). The published computeIndex on /v1/oracle/scu, /v1/oracle/latest and each /v1/oracle/history point equals (baseline.scuUsd / point.scuUsd) × 100 — 100 at genesis, rises as compute gets cheaper. Returns null until the first revision is confirmed.",
    inputSchema: NO_ARGS,
    annotations: ORACLE,
  },
  {
    name: "data_get_scu_at",
    description:
      "SCU value active at a specific timestamp via step function — no interpolation. Source: Oracle API (/v1/oracle/scu-at). Resolves the latest confirmed revision with publishedAt ≤ date and returns its scuUsd, scuUsd18, computeIndex, revisionVersion, methodologyVersion, publishedAt, and metadataHash. Monotonicity is non-strict — when two confirmed revisions share publishedAt the highest revisionVersion wins. computeIndex is derived as (baseline.scuUsd / scuUsd) × 100, the same formula as data_get_scu and each data_get_history point. Returns null when the date precedes the genesis revision; errors on malformed or future dates. Use data_get_history for a bucketed series; use data_get_scu_at for a single-point lookup.",
    inputSchema: {
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
    annotations: ORACLE,
  },

  {
    name: "compute_estimate",
    description:
      "Nominal USD cost for any oracle-tracked model given input/output token counts (no cache discounts) — basket members and catalog-only models on identical terms. Returns `base_usd_cost` (provider list price), `routing_fee_usd` and `billed_usd_cost` (what compute.finance charges), plus the `routing_fee_rate` they derive from. Compare models on base_usd_cost; budget on billed_usd_cost. " +
      `${PROVENANCE_NOTE} \`base_price_provenance\` marks the input and output prices this cost is built from exactly when they are catalogue numbers, and is null when they are attested manifest figures — read the field, price_source does not decide it. ` +
      "`price_source` ('oracle-basket' | 'oracle-catalog') names the serving endpoint only and does not change the pricing basis, so two models with the same provider price return the same cost. Reasoning tokens are billed inside output_tokens, so this estimate adds no separate reasoning leg; read the model's reasoning price from data_get_price. Errors with 'Model not tracked by oracle' for unknown keys. Source: Oracle API (/v1/oracle/resolve + /v1/oracle/basket). For cache-aware cost, use analyze_session on a real transcript. Models are identified by their canonical vendor-prefixed id ('anthropic/claude-sonnet-4.6', 'openai/gpt-5.5'); the bare name ('gpt-5.5') resolves to the same model, and the response echoes the canonical id. The vendor slug is not always provider.key (alibaba → qwen, xai → x-ai, moonshot → moonshotai), so pass an id the API returned rather than assembling one.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Canonical vendor-prefixed model id (e.g. 'anthropic/claude-sonnet-4.6'); the bare name also resolves.",
          examples: ["anthropic/claude-sonnet-4.6"],
        },
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
      "Rank all basket models by nominal cost for a workload. Source: Oracle API. Each row carries `base_usd_cost` (provider list price), `routing_fee_usd` and `billed_usd_cost` (what compute.finance charges); ranking is by base_usd_cost, and since the routing fee is one global rate the order is identical on either basis. Returns the sorted list plus a grouping by family (e.g. openai.gpt, anthropic.claude). Covers basket members only — for a catalog-only model use compute_estimate, whose numbers are on the same basis. Use to answer 'which model is cheapest?' or 'how much would this cost on a different model?'.",
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
      "Raw JSON session analysis — token totals, effective/nominal cost with cache breakdown, counterfactual across all basket models, profile classification. `current_model_cost` is on the base (provider list) basis, stated in `current_model_cost_basis`; `counterfactual_nominal` rows carry `base_usd_cost` and `billed_usd_cost`, so the session and the counterfactual are directly comparable on base. `usage.prompts` counts user messages, `usage.inferences` counts assistant replies, `usage.tool_calls` counts tool_use blocks. `current_model_cost.effective_usd` is `null` when the oracle has not published cache pricing for the model; `nominal_usd` stays populated as an upper-bound. Source: local Claude Code transcript + Oracle API. For pre-formatted output use render_session_report. Omit session_id for the most recent session.",
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
    inputSchema: NO_ARGS,
    annotations: { ...LOCAL, openWorldHint: true },
  },
];

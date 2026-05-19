#!/usr/bin/env node
/**
 * Compute Finance MCP Server
 *
 * Proxies the **public, unauthenticated** Oracle API at api.compute.finance:
 *
 *   GET /v1/oracle/basket          — CPI basket (models, prices, tiers)
 *   GET /v1/oracle/pricing         — per-model pricing with optional cache block
 *   GET /v1/oracle/scu             — Standard Compute Unit benchmark
 *   GET /v1/oracle/tiers           — tier weights and averages
 *   GET /v1/oracle/reconstitutions — historical basket changes
 *
 * Authenticated endpoints (pools, billing, admin) are out of scope.
 * This server is read-only and requires no API key.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getBasketPrices,
  getModelPrice,
  getScu,
  getCpi,
  getTiers,
  getReconstitutions,
  costUsd,
  effectiveCost,
  resolveCanonicalIn,
} from "./oracle/client.js";
import {
  getAllOracleToolSchemas,
  getAllOracleToolResponseSchemas,
  isOracleBackedTool,
  warmOpenApiCache,
  FALLBACK_SCHEMAS,
} from "./oracle/openapi-schema.js";
import { initFieldMap, getFieldMap } from "./oracle/field-map.js";
import {
  findSessionFile,
  findLatestSessionFile,
  parseSessionUsage,
} from "./storage/session.js";
import { logSession, getStats } from "./storage/history.js";
import { parseTurns, logTurns } from "./storage/turns.js";
import { isValidSessionId } from "./storage/tools.js";
import { classifyProfile } from "./storage/profile.js";
import { renderSessionReport } from "./render/session_report.js";
import { renderConsumptionReport } from "./render/consumption_report.js";
import { renderActiveSessions } from "./render/sessions_list.js";
import { round } from "./render/format.js";

// Single source of truth: read version from package.json at runtime.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
) as { version: string };

const server = new Server(
  { name: "compute-finance-mcp", version: pkg.version },
  { capabilities: { tools: {} } },
);

// ── Tool definitions ─────────────────────────────────────────────────
//
// Oracle-backed tools (data_get_*) derive their inputSchema from the
// OpenAPI spec at startup. Local compute/render/analysis tools keep
// hardcoded schemas since they have no corresponding Oracle endpoint.
//
// The `inputSchema` field on oracle-backed entries below is a placeholder
// — it gets replaced by buildTools() before the server starts.

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const toolDefinitions: ToolDef[] = [
  // ── Data (live oracle) — schemas derived from OpenAPI at startup ────
  // Inline inputSchema uses FALLBACK_SCHEMAS (single source of truth).
  // buildTools() replaces these with OpenAPI-derived schemas when available.
  {
    name: "data_get_basket",
    description:
      "List all models tracked by the Compute Finance Oracle with provider, tier, live USD prices per million tokens, and cache multipliers (source: oracle or local-fallback).",
    inputSchema: FALLBACK_SCHEMAS.data_get_basket,
  },
  {
    name: "data_get_price",
    description:
      "Live oracle price for a single model (input/output USD per million, compute units, cache multipliers).",
    inputSchema: FALLBACK_SCHEMAS.data_get_price,
  },
  {
    name: "data_get_scu",
    description:
      "Current Standard Compute Unit (SCU) — Compute Finance's market benchmark price.",
    inputSchema: FALLBACK_SCHEMAS.data_get_scu,
  },
  {
    name: "data_get_cpi",
    description:
      "Live AI Compute Price Index from /v1/oracle/basket — full basket with provider, tier, integration flag, raw and marked-up prices, SCU breakdown, basket version. Canonical source-of-truth for what models the index is currently tracking.",
    inputSchema: FALLBACK_SCHEMAS.data_get_cpi,
  },
  {
    name: "data_get_tiers",
    description:
      "Tier weights and per-tier average cost from /v1/oracle/tiers — frontier 30% / standard 40% / lightweight 30%, plus model count and SCU contribution per tier.",
    inputSchema: FALLBACK_SCHEMAS.data_get_tiers,
  },
  {
    name: "data_get_reconstitutions",
    description:
      "Historical basket reconstitution events from /v1/oracle/reconstitutions — every model swap with date, basket version, models added/removed, SCU before/after, and source URL. Use to explain how the index has evolved.",
    inputSchema: FALLBACK_SCHEMAS.data_get_reconstitutions,
  },

  // ── Compute (local — no Oracle endpoint) ───────────────────────────
  {
    name: "compute_estimate",
    description:
      "Nominal USD cost for a model given input/output token counts. Uses live oracle prices.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        input_tokens: { type: "number" },
        output_tokens: { type: "number" },
      },
      required: ["model", "input_tokens", "output_tokens"],
    },
  },
  {
    name: "compute_compare",
    description:
      "Rank all basket models by nominal cost for a workload. Returns sorted table grouped by tier.",
    inputSchema: {
      type: "object",
      properties: {
        input_tokens: { type: "number" },
        output_tokens: { type: "number" },
      },
      required: ["input_tokens", "output_tokens"],
    },
  },

  // ── Render (code-driven, skill-facing — no Oracle endpoint) ────────
  {
    name: "render_session_report",
    description:
      "CODE-DRIVEN ENTRY POINT for cf-session-management. Reads the transcript, prices it, logs to history, computes insights, and returns a single pre-formatted multi-line `text` string. Skills must print the `text` field verbatim — no reformatting, no interpretation, no additional tool calls. Output is byte-identical across models/hosts.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "render_consumption_report",
    description:
      "CODE-DRIVEN ENTRY POINT for cf-session-consumption. Returns a pre-formatted per-turn breakdown (bar chart, tool aggregates, mechanical facts) as a single `text` string. Persists turns to ~/.compute-finance-mcp/turns.jsonl. Skills must print verbatim.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        cwd: { type: "string" },
        full: {
          type: "boolean",
          description:
            "If true, show every turn (no top-10/last-5 truncation). Default false.",
        },
      },
    },
  },
  {
    name: "render_active_sessions",
    description:
      "CODE-DRIVEN summary of recent sessions across Claude Code projects. Useful when multiple sessions run in parallel — returns one pre-formatted table with per-session tokens + effective/nominal cost. Skills must print verbatim.",
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
  },

  // ── Raw analysis (no Oracle endpoint) ──────────────────────────────
  {
    name: "analyze_session",
    description:
      "RAW JSON session analysis. For MCP clients building custom UI. Claude Code skills should prefer render_session_report. Returns token totals, model, effective/nominal cost, counterfactual across basket, profile.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "analyze_turns",
    description:
      "RAW JSON per-turn breakdown. For MCP clients building custom UI. Claude Code skills should prefer render_consumption_report.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },

  // ── History (local) ────────────────────────────────────────────────
  {
    name: "telemetry_get_history",
    description:
      "Aggregate stats across measured sessions (deduped by session_id, last-wins): sample size, cumulative effective vs nominal, per-profile medians, data-driven insights.",
    inputSchema: { type: "object", properties: {} },
  },
];

/**
 * Build the final tools array by replacing oracle-backed tool schemas
 * with those derived from the OpenAPI spec. Falls back to the inline
 * schemas above if the spec is unreachable.
 */
async function buildTools(): Promise<ToolDef[]> {
  const oracleSchemas = await getAllOracleToolSchemas();
  const responseSchemas = await getAllOracleToolResponseSchemas();

  return toolDefinitions.map((tool) => {
    let updated = tool;
    if (isOracleBackedTool(tool.name) && oracleSchemas[tool.name]) {
      updated = { ...updated, inputSchema: oracleSchemas[tool.name] };
    }
    if (responseSchemas[tool.name]) {
      updated = {
        ...updated,
        description:
          updated.description +
          "\n\nOracle response schema (auto-derived from OpenAPI at startup):\n" +
          JSON.stringify(responseSchemas[tool.name]),
      };
    }
    return updated;
  });
}

// Eagerly warm the OpenAPI cache, derive field mappings, and build the
// tools array so ListTools doesn't block on the first request.
const startupPromise = warmOpenApiCache().then(() =>
  Promise.all([buildTools(), initFieldMap()]),
);
const toolsPromise: Promise<ToolDef[]> = startupPromise.then(([tools]) => tools);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: await toolsPromise,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  await startupPromise;
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "data_get_basket": {
        const basket = await getBasketPrices();
        return text({
          models: basket,
          source: "api.compute.finance/v1/oracle/basket (+ /v1/oracle/pricing for cache multipliers when published)",
        });
      }
      case "data_get_price": {
        const model = requireString(a.model, "model");
        if (typeof model !== "string") return errorText(model.error);
        const price = await getModelPrice(model);
        if (!price) return errorText(`Model not in basket: ${model}`);
        return text(price);
      }
      case "data_get_scu": {
        return text(await getScu());
      }
      case "data_get_cpi": {
        return text(await getCpi());
      }
      case "data_get_tiers": {
        return text(await getTiers());
      }
      case "data_get_reconstitutions": {
        const limit = optionalPositiveNumber(a.limit, "limit");
        if (typeof limit === "object" && limit !== null) return errorText(limit.error);
        const fm = getFieldMap().recon;
        const data = await getReconstitutions() as Record<string, unknown>;
        const entries = (data[fm.entries_array] ?? []) as Record<string, unknown>[];
        const sorted = [...entries].sort(
          (a, b) =>
            new Date(b[fm.sort_date] as string).getTime() -
            new Date(a[fm.sort_date] as string).getTime(),
        );
        return text(
          typeof limit === "number"
            ? { [fm.entries_array]: sorted.slice(0, limit) }
            : { [fm.entries_array]: sorted },
        );
      }
      case "compute_estimate": {
        const model = requireString(a.model, "model");
        if (typeof model !== "string") return errorText(model.error);
        const inT = requireFiniteNumber(a.input_tokens, "input_tokens");
        if (typeof inT !== "number") return errorText(inT.error);
        const outT = requireFiniteNumber(a.output_tokens, "output_tokens");
        if (typeof outT !== "number") return errorText(outT.error);
        const price = await getModelPrice(model);
        if (!price) return errorText(`Model not in basket: ${model}`);
        const usd = costUsd(price, inT, outT);
        return text({
          model: price.model,
          input_tokens: inT,
          output_tokens: outT,
          usd_cost: round(usd, 6),
          source: "api.compute.finance/v1/oracle/basket",
        });
      }
      case "compute_compare": {
        const inT = requireFiniteNumber(a.input_tokens, "input_tokens");
        if (typeof inT !== "number") return errorText(inT.error);
        const outT = requireFiniteNumber(a.output_tokens, "output_tokens");
        if (typeof outT !== "number") return errorText(outT.error);
        const basket = await getBasketPrices();
        const ranked = basket
          .map((p) => ({
            model: p.model,
            provider: p.provider,
            tier: p.tier,
            usd_cost: round(costUsd(p, inT, outT), 6),
          }))
          .sort((x, y) => x.usd_cost - y.usd_cost);
        return text({
          input_tokens: inT,
          output_tokens: outT,
          ranked,
          by_tier: {
            frontier: ranked.filter((r) => r.tier === "frontier"),
            standard: ranked.filter((r) => r.tier === "standard"),
            lightweight: ranked.filter((r) => r.tier === "lightweight"),
          },
          source: "api.compute.finance/v1/oracle/basket",
        });
      }

      case "render_session_report": {
        const sid = checkOptionalSessionId(a.session_id);
        if (sid && typeof sid === "object") return errorText(sid.error);
        const cwd = optionalString(a.cwd, "cwd");
        if (typeof cwd === "object" && cwd !== null) return errorText(cwd.error);
        const rendered = await renderSessionReport({ session_id: sid, cwd });
        return text({ text: rendered });
      }
      case "render_consumption_report": {
        const sid = checkOptionalSessionId(a.session_id);
        if (sid && typeof sid === "object") return errorText(sid.error);
        const cwd = optionalString(a.cwd, "cwd");
        if (typeof cwd === "object" && cwd !== null) return errorText(cwd.error);
        const full = optionalBoolean(a.full, "full");
        if (typeof full === "object" && full !== null) return errorText(full.error);
        const rendered = await renderConsumptionReport({
          session_id: sid,
          cwd,
          full,
        });
        return text({ text: rendered });
      }
      case "render_active_sessions": {
        const cwd = optionalString(a.cwd, "cwd");
        if (typeof cwd === "object" && cwd !== null) return errorText(cwd.error);
        const limit = optionalPositiveNumber(a.limit, "limit");
        if (typeof limit === "object" && limit !== null) return errorText(limit.error);
        const hours = optionalPositiveNumber(a.hours, "hours");
        if (typeof hours === "object" && hours !== null) return errorText(hours.error);
        const rendered = await renderActiveSessions({
          cwd,
          limit: limit as number | undefined,
          hours: hours as number | undefined,
        });
        return text({ text: rendered });
      }

      case "analyze_session": {
        const result = await rawAnalyzeSession(a);
        if (isErrorResult(result)) return errorText(result.error);
        return text(result);
      }
      case "analyze_turns": {
        const result = await rawAnalyzeTurns(a);
        if (isErrorResult(result)) return errorText(result.error);
        return text(result);
      }
      case "telemetry_get_history": {
        const basket = await getBasketPrices();
        return text(await getStats(basket));
      }
      default:
        return errorText(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorText((err as Error).message);
  }
});

async function rawAnalyzeSession(a: Record<string, unknown>) {
  const sidCheck = checkOptionalSessionId(a.session_id);
  if (sidCheck && typeof sidCheck === "object") return sidCheck;
  const cwdCheck = optionalString(a.cwd, "cwd");
  if (typeof cwdCheck === "object" && cwdCheck !== null) return cwdCheck;
  const sid = sidCheck;
  const cwd = cwdCheck;
  const path = sid ? findSessionFile(sid, cwd) : findLatestSessionFile(cwd);
  if (!path) return { error: "No session transcript found" };
  const usage = parseSessionUsage(path);

  const basket = await getBasketPrices();
  const normalized = resolveCanonicalIn(usage.model, basket);
  const totalIn =
    usage.raw_input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
  const counterfactual = basket
    .map((p) => ({
      model: p.model,
      provider: p.provider,
      tier: p.tier,
      usd_cost: round(costUsd(p, totalIn, usage.output_tokens), 6),
    }))
    .sort((x, y) => x.usd_cost - y.usd_cost);

  let current: unknown = null;
  let effective_usd: number | null = null;
  let nominal_usd: number | null = null;
  if (normalized) {
    const price = basket.find((p) => p.model === normalized) ?? null;
    if (price) {
      const eff = effectiveCost(
        price,
        usage.raw_input_tokens,
        usage.cache_read_tokens,
        usage.cache_creation_tokens,
        usage.output_tokens,
      );
      effective_usd = round(eff.effective_usd, 6);
      nominal_usd = round(eff.nominal_usd, 6);
      current = {
        model: normalized,
        effective_usd,
        nominal_usd,
        savings_from_cache_usd: round(eff.nominal_usd - eff.effective_usd, 6),
        breakdown: {
          raw_input_usd: round(eff.breakdown.raw_input_usd, 6),
          cache_read_usd: round(eff.breakdown.cache_read_usd, 6),
          cache_create_usd: round(eff.breakdown.cache_create_usd, 6),
          output_usd: round(eff.breakdown.output_usd, 6),
        },
        cache_source: eff.cache_source,
        notes: eff.notes,
      };
    }
  }

  const prof = classifyProfile(usage);

  // Persist for consumers that compose analyze_session manually.
  logSession({
    session_id: usage.session_id,
    model: normalized,
    in_basket: normalized !== null,
    profile: prof.profile,
    raw_input_tokens: usage.raw_input_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    output_tokens: usage.output_tokens,
    turns: usage.turns,
    tool_calls: usage.tool_calls,
    edits: usage.edits,
    reads: usage.reads,
    extended_thinking_used: usage.extended_thinking_used,
    effective_usd,
    nominal_usd,
    out_in_ratio: prof.out_in_ratio,
  });

  return {
    session: {
      session_id: usage.session_id,
      cwd: usage.cwd,
      model_raw: usage.model,
      model_normalized: normalized,
      in_basket: normalized !== null,
    },
    usage: {
      raw_input_tokens: usage.raw_input_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_creation_tokens: usage.cache_creation_tokens,
      output_tokens: usage.output_tokens,
      turns: usage.turns,
      tool_calls: usage.tool_calls,
      edits: usage.edits,
      reads: usage.reads,
      extended_thinking_used: usage.extended_thinking_used,
    },
    current_model_cost: current,
    counterfactual_nominal: counterfactual,
    profile: prof,
    source: "api.compute.finance/v1/oracle/basket + local transcript",
  };
}

async function rawAnalyzeTurns(a: Record<string, unknown>) {
  const sidCheck = checkOptionalSessionId(a.session_id);
  if (sidCheck && typeof sidCheck === "object") return sidCheck;
  const cwdCheck = optionalString(a.cwd, "cwd");
  if (typeof cwdCheck === "object" && cwdCheck !== null) return cwdCheck;
  const sid = sidCheck;
  const cwd = cwdCheck;
  const path = sid ? findSessionFile(sid, cwd) : findLatestSessionFile(cwd);
  if (!path) return { error: "No session transcript found" };
  const result = parseTurns(path);

  const basket = await getBasketPrices();
  const normalized = resolveCanonicalIn(result.model, basket);
  const price = normalized
    ? (basket.find((p) => p.model === normalized) ?? null)
    : null;
  const turnsWithCost = result.turns.map((t) => {
    let effective_usd: number | null = null;
    let nominal_usd: number | null = null;
    if (price) {
      const eff = effectiveCost(
        price,
        t.raw_input_tokens,
        t.cache_read_tokens,
        t.cache_creation_tokens,
        t.output_tokens,
      );
      effective_usd = round(eff.effective_usd, 6);
      nominal_usd = round(eff.nominal_usd, 6);
    }
    return { ...t, effective_usd, nominal_usd };
  });

  logTurns(result.turns);

  return {
    session_id: result.session_id,
    model: result.model,
    model_normalized: normalized,
    total_turns: result.total_turns,
    totals: result.totals,
    by_tool: result.by_tool,
    cache_hit_ratio: round(result.cache_hit_ratio, 3),
    turns: turnsWithCost,
    source: "api.compute.finance/v1/oracle/basket + local transcript",
  };
}

function text(obj: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function isErrorResult(v: unknown): v is { error: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "error" in v &&
    typeof (v as Record<string, unknown>).error === "string"
  );
}

/** Wraps an error message with `isError: true` so MCP clients can
 *  programmatically distinguish errors from successful data. */
function errorText(msg: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }],
    isError: true,
  };
}

// Defense-in-depth argument guards. The MCP SDK already validates against
// inputSchema, but clients that skip schema enforcement can still reach the
// handler — a bad number there silently poisons costUsd with NaN.
function requireString(
  v: unknown,
  name: string,
): string | { error: string } {
  return typeof v === "string" && v.length > 0
    ? v
    : { error: `${name} must be a non-empty string` };
}

function requireFiniteNumber(
  v: unknown,
  name: string,
): number | { error: string } {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? v
    : { error: `${name} must be a non-negative finite number` };
}

// Optional string that must match the UUID-shape guard if provided. Returns
// `undefined` (no id supplied), the validated string, or a structured error.
function checkOptionalSessionId(
  v: unknown,
): string | undefined | { error: string } {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !isValidSessionId(v)) {
    return { error: "session_id must be UUID-shaped (alphanumeric and hyphens)" };
  }
  return v;
}

// `undefined` is valid (not supplied), anything else must be a string.
function optionalString(
  v: unknown,
  name: string,
): string | undefined | { error: string } {
  if (v === undefined || v === null) return undefined;
  return typeof v === "string"
    ? v
    : { error: `${name} must be a string if provided` };
}

// `undefined` is valid (not supplied), anything else must be a boolean.
function optionalBoolean(
  v: unknown,
  name: string,
): boolean | undefined | { error: string } {
  if (v === undefined || v === null) return undefined;
  return typeof v === "boolean"
    ? v
    : { error: `${name} must be a boolean if provided` };
}

// `undefined` is valid (means "use default"), anything else must be a positive finite number.
function optionalPositiveNumber(
  v: unknown,
  name: string,
): number | undefined | { error: string } {
  if (v === undefined || v === null) return undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? v
    : { error: `${name} must be a positive finite number if provided` };
}

const transport = new StdioServerTransport();
await server.connect(transport);

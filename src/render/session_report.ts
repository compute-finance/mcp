import {
  getBasketPrices,
  getActiveMethodologyVersion,
  getScuValue,
  resolveModel,
  resolvedToModelPrice,
} from "../oracle/client.js";
import {
  cacheAttributionNote,
  priceSession,
  OracleCachePricingMissingError,
} from "../oracle/pricing.js";
import {
  findSessionFile,
  findLatestSessionFile,
  parseSessionUsage,
  UsageTotals,
} from "../storage/session.js";
import { logSession, getStats } from "../storage/history.js";
import { classifyProfile } from "../storage/profile.js";
import { ModelPrice, ScuValue } from "../oracle/types.js";
import { line, round } from "./format.js";
import { renderCostBlock } from "./blocks/cost.js";
import { renderHistoryBlock } from "./blocks/history.js";
import { renderOverheadBlock } from "./blocks/overhead.js";
import { renderScuPositionBlock } from "./blocks/scu_position.js";
import { renderTokensBlock } from "./blocks/tokens.js";
import { renderXIndexLadderBlock } from "./blocks/x_index_ladder.js";

// "Net realized vs market" synthesis line — deferred until its formula is agreed.
const SCU_SYNTHESIS_ENABLED = false;

export interface SessionReportArgs {
  session_id?: string;
  cwd?: string;
}

export async function renderSessionReport(
  args: SessionReportArgs,
): Promise<string> {
  const path = args.session_id
    ? findSessionFile(args.session_id, args.cwd)
    : findLatestSessionFile(args.cwd);
  if (!path) return "Compute Finance Oracle — no session transcript found.";

  const usage = parseSessionUsage(path);
  const { profile, out_in_ratio } = classifyProfile(usage);

  let basket: ModelPrice[];
  try {
    basket = await getBasketPrices();
  } catch (err) {
    // Oracle unreachable: raw usage only, DO NOT log.
    return renderOracleUnreachable(usage, profile, err as Error);
  }

  const [methodologyVersion, resolved] = await Promise.all([
    getActiveMethodologyVersion(),
    resolveModel(usage.model),
  ]);
  const normalized =
    resolved && resolved.price_source !== "off-basket"
      ? resolved.resolved_key
      : null;

  // Separate endpoint from the basket — on failure omit the SCU blocks, don't sink the report.
  let scu: ScuValue | null = null;
  try {
    scu = await getScuValue();
  } catch {
    scu = null;
  }
  const scu_usd = scu?.scuUsd ?? 0;

  let effective_usd: number | null = null;
  let nominal_usd: number | null = null;
  let cacheNote: string | null = null;
  let cachePricingMissing: OracleCachePricingMissingError | null = null;
  let sessionPrice: ModelPrice | null = null;
  let cached_input_usd_per_million = 0;
  if (normalized && resolved) {
    const price = resolvedToModelPrice(resolved);
    // resolve names a model by its key; prefer the basket's display name when the model is in-basket.
    const basketRow = basket.find((p) => p.model === price.model);
    sessionPrice = basketRow
      ? { ...price, display_name: basketRow.display_name }
      : price;
    {
      cached_input_usd_per_million =
        sessionPrice.cache?.cachedInput?.usdPerMillion ?? 0;
      const r = priceSession(
        sessionPrice,
        usage.raw_input_tokens,
        usage.cache_read_tokens,
        usage.cache_creation_tokens,
        usage.output_tokens,
      );
      nominal_usd = round(r.nominal_usd, 4);
      if (r.effective) {
        effective_usd = round(r.effective.effective_usd, 4);
        cacheNote = cacheAttributionNote(sessionPrice.cache);
      } else {
        cachePricingMissing = r.cache_pricing_missing;
      }
    }
  }

  const stats = await getStats(basket, usage.session_id);

  logSession({
    session_id: usage.session_id,
    model: normalized,
    in_basket: resolved?.in_basket ?? false,
    profile,
    raw_input_tokens: usage.raw_input_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    output_tokens: usage.output_tokens,
    prompts: usage.prompts,
    inferences: usage.inferences,
    tool_calls: usage.tool_calls,
    edits: usage.edits,
    reads: usage.reads,
    extended_thinking_used: usage.extended_thinking_used,
    effective_usd,
    nominal_usd,
    out_in_ratio,
  });

  const L: string[] = [];
  L.push("Compute Finance Oracle — Session analysis");
  L.push(
    `Source: api.compute.finance/v1/oracle/basket + local transcript (measured)${
      methodologyVersion === null ? "" : ` · oracle methodology v${methodologyVersion}`
    }`,
  );
  L.push("");
  L.push(
    line(
      `Session: ${usage.session_id}  ·  Model: ${normalized ?? usage.model ?? "unknown"}${normalized ? "" : "  (off-basket)"}`,
    ),
  );
  L.push("");
  L.push(...renderTokensBlock(usage, usage.inferences));
  L.push(
    `  ${usage.prompts} prompts · ${usage.inferences} inferences · ${usage.tool_calls} tool calls · ${usage.edits} edits · ${usage.reads} reads · thinking ${usage.extended_thinking_used ? "yes" : "no"}`,
  );
  L.push("");
  L.push(
    ...renderCostBlock({
      effective_usd,
      nominal_usd,
      cache_multipliers_note: cacheNote,
      cache_pricing_missing: cachePricingMissing
        ? {
            model: cachePricingMissing.model,
            missing: cachePricingMissing.missing,
          }
        : null,
    }),
  );

  if (scu) {
    L.push("");
    for (const l of renderScuPositionBlock({
      scu,
      effective_usd,
      nominal_usd,
      price: sessionPrice,
      synthesis: SCU_SYNTHESIS_ENABLED,
    })) {
      L.push(l);
    }
    const ladder = renderXIndexLadderBlock({ scu, basket, price: sessionPrice });
    if (ladder.length) {
      L.push("");
      for (const l of ladder) L.push(l);
    }
  }

  const overheadLines = renderOverheadBlock({
    fixed_overhead_tokens: usage.first_inference_cache_creation_tokens,
    inferences: usage.inferences,
    scu_usd,
    cached_input_usd_per_million,
  });
  if (overheadLines.length > 0) {
    L.push("");
    L.push(...overheadLines);
  }

  L.push("");
  L.push(`Profile: ${profile}`);

  const historyLines = renderHistoryBlock({ stats, profile, effective_usd });
  if (historyLines.length > 0) {
    L.push("");
    L.push(...historyLines);
  }

  for (const ins of stats.insights) {
    L.push("");
    L.push(`Insight: ${ins.message}`);
  }

  L.push("");
  L.push(`Session #${stats.distinct_sessions} logged.`);

  return L.join("\n");
}

function renderOracleUnreachable(
  usage: UsageTotals,
  profile: string,
  err: Error,
): string {
  const L: string[] = [];
  L.push("Compute Finance Oracle — Session analysis");
  L.push("Source: local transcript only (oracle unreachable)");
  L.push("");
  L.push(`Session: ${usage.session_id}  ·  Model: ${usage.model ?? "unknown"}`);
  L.push("");
  L.push(...renderTokensBlock(usage, usage.inferences));
  L.push(
    `  ${usage.prompts} prompts · ${usage.inferences} inferences · ${usage.tool_calls} tool calls · ${usage.edits} edits · ${usage.reads} reads · thinking ${usage.extended_thinking_used ? "yes" : "no"}`,
  );
  L.push("");
  L.push(`Profile: ${profile}`);
  L.push("");
  L.push(`oracle unreachable — pricing skipped (${err.message}). Session NOT logged.`);
  return L.join("\n");
}


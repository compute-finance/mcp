import {
  getBasketPrices,
  getActiveMethodologyVersion,
  priceSession,
  OracleCachePricingMissingError,
  costUsd,
  resolveCanonicalIn,
} from "../oracle/client.js";
import {
  findSessionFile,
  findLatestSessionFile,
  parseSessionUsage,
  UsageTotals,
} from "../storage/session.js";
import { logSession, getStats } from "../storage/history.js";
import { classifyProfile } from "../storage/profile.js";
import { ModelPrice } from "../oracle/types.js";
import { money, renderTokensBlock, line, round } from "./format.js";
import { renderCostBlock, renderHistoryBlock } from "./blocks.js";

export interface SessionReportArgs {
  session_id?: string;
  cwd?: string;
}

function pickCheapestByFamily(basket: ModelPrice[]): ModelPrice[] {
  const byFamily = new Map<string, ModelPrice>();
  for (const p of basket) {
    const key = p.family || `${p.provider}.${p.model}`;
    const existing = byFamily.get(key);
    const cost = p.input_usd_per_million + p.output_usd_per_million;
    if (
      !existing ||
      cost < existing.input_usd_per_million + existing.output_usd_per_million
    ) {
      byFamily.set(key, p);
    }
  }
  return Array.from(byFamily.values()).sort(
    (a, b) =>
      a.input_usd_per_million + a.output_usd_per_million -
      (b.input_usd_per_million + b.output_usd_per_million),
  );
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

  const normalized = resolveCanonicalIn(usage.model, basket);
  const methodologyVersion = await getActiveMethodologyVersion();

  const totalIn =
    usage.raw_input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;

  let effective_usd: number | null = null;
  let nominal_usd: number | null = null;
  let cacheNote = "";
  let cachePricingMissing: OracleCachePricingMissingError | null = null;
  if (normalized) {
    const price = basket.find((p) => p.model === normalized) ?? null;
    if (price) {
      const r = priceSession(
        price,
        usage.raw_input_tokens,
        usage.cache_read_tokens,
        usage.cache_creation_tokens,
        usage.output_tokens,
      );
      nominal_usd = round(r.nominal_usd, 4);
      if (r.effective) {
        effective_usd = round(r.effective.effective_usd, 4);
        cacheNote = r.effective.notes[0];
      } else {
        cachePricingMissing = r.cache_pricing_missing;
      }
    }
  }

  const stats = await getStats(basket, usage.session_id);

  logSession({
    session_id: usage.session_id,
    model: normalized,
    in_basket: normalized !== null,
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

  const counterfactual = pickCheapestByFamily(basket);

  // Strip `claude-` prefix so counterfactual rows stay tight (`opus-4.6` vs `claude-opus-4.6`).
  const shortName = (m: string) => m.replace(/^claude-/, "");
  const fmtCounterfactualRow = (p: ModelPrice) =>
    `${p.family.padEnd(22)} ${shortName(p.model)} ${money(round(costUsd(p, totalIn, usage.output_tokens), 4))}`;

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
      cache_note: cacheNote,
      cache_pricing_missing: cachePricingMissing
        ? {
            model: cachePricingMissing.model,
            missing: cachePricingMissing.missing,
          }
        : null,
    }),
  );
  L.push("");
  L.push("Same shape on alternatives (cheapest representative per family, nominal):");
  for (const p of counterfactual) L.push(`  ${fmtCounterfactualRow(p)}`);
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

export const _internals = {
  pickCheapestByFamily,
};

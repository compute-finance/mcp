import {
  getBasketPrices,
  effectiveCost,
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
import { money, tokens, line, round } from "./format.js";

export interface SessionReportArgs {
  session_id?: string;
  cwd?: string;
}

function pickCheapestByTier(basket: ModelPrice[], tier: string): ModelPrice[] {
  const filtered = basket.filter((p) => p.tier === tier);
  const byProvider = new Map<string, ModelPrice>();
  for (const p of filtered) {
    const existing = byProvider.get(p.provider);
    const cost = p.input_usd_per_million + p.output_usd_per_million;
    if (
      !existing ||
      cost < existing.input_usd_per_million + existing.output_usd_per_million
    ) {
      byProvider.set(p.provider, p);
    }
  }
  return Array.from(byProvider.values());
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

  const totalIn =
    usage.raw_input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;

  let effective_usd: number | null = null;
  let nominal_usd: number | null = null;
  let cacheNote = "";
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
      effective_usd = round(eff.effective_usd, 4);
      nominal_usd = round(eff.nominal_usd, 4);
      cacheNote = eff.notes[0];
    }
  }

  const log = logSession({
    session_id: usage.session_id,
    model: normalized,
    in_basket: normalized !== null,
    profile,
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
    out_in_ratio,
  });
  void log;

  const stats = await getStats(basket);

  const frontiers = pickCheapestByTier(basket, "frontier");
  const standards = pickCheapestByTier(basket, "standard");
  const lights = pickCheapestByTier(basket, "lightweight");

  // Strip provider prefix to match the original report template
  // (`opus-4.6`, not `claude-opus-4.6`) — tighter, easier to scan.
  const shortName = (m: string) => m.replace(/^claude-/, "");
  const fmtCounterfactual = (arr: ModelPrice[]) =>
    arr
      .map(
        (p) =>
          `${shortName(p.model)} ${money(round(costUsd(p, totalIn, usage.output_tokens), 4))}`,
      )
      .join("   ");

  const L: string[] = [];
  L.push("Compute Finance Oracle — Session analysis");
  L.push("Source: api.compute.finance/v1/oracle/basket + local transcript (measured)");
  L.push("");
  L.push(
    line(
      `Session: ${usage.session_id}  ·  Model: ${normalized ?? usage.model ?? "unknown"}${normalized ? "" : "  (off-basket)"}`,
    ),
  );
  L.push("");
  L.push("Tokens:");
  L.push(
    `  Input ${tokens(usage.raw_input_tokens)} raw · ${tokens(usage.cache_read_tokens)} cache-read · ${tokens(usage.cache_creation_tokens)} cache-create · ${tokens(usage.output_tokens)} output`,
  );
  L.push(
    `  ${usage.turns} turns · ${usage.tool_calls} tool calls · ${usage.edits} edits · ${usage.reads} reads · thinking ${usage.extended_thinking_used ? "yes" : "no"}`,
  );
  L.push("");
  if (effective_usd !== null && nominal_usd !== null) {
    L.push("Cost (this session):");
    L.push(`  Effective (cache-aware):  ${money(effective_usd)}`);
    L.push(`  Nominal (no cache):       ${money(nominal_usd)}`);
    L.push(
      `  Saved by caching:         ${money(round(nominal_usd - effective_usd, 4))}`,
    );
    if (cacheNote) L.push(`  ${cacheNote}`);
  } else {
    L.push("Cost (this session):");
    L.push("  Current model not tracked by oracle — effective cost unavailable.");
  }
  L.push("");
  L.push("Same shape on alternatives (nominal, no cache):");
  if (frontiers.length) L.push(`  Frontier    ${fmtCounterfactual(frontiers)}`);
  if (standards.length) L.push(`  Standard    ${fmtCounterfactual(standards)}`);
  if (lights.length) L.push(`  Lightweight ${fmtCounterfactual(lights)}`);
  L.push("");
  L.push(`Profile: ${profile}`);

  if (stats.sample_size >= 3) {
    const prof = stats.by_profile[profile];
    L.push("");
    L.push(
      `Your history (n=${stats.distinct_sessions} sessions · ${money(stats.cumulative_effective_usd)} effective cumulative, ${money(stats.cumulative_nominal_usd)} nominal):`,
    );
    if (prof && prof.median_effective_usd > 0 && effective_usd !== null) {
      const ratio = effective_usd / prof.median_effective_usd - 1;
      const direction = ratio >= 0 ? "above" : "below";
      L.push(
        `  This profile (${profile}): median ${money(prof.median_effective_usd)}  ·  this session ${money(effective_usd)}  →  ${Math.abs(Math.round(ratio * 100))}% ${direction} typical`,
      );
    }
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
  L.push("Tokens:");
  L.push(
    `  Input ${tokens(usage.raw_input_tokens)} raw · ${tokens(usage.cache_read_tokens)} cache-read · ${tokens(usage.cache_creation_tokens)} cache-create · ${tokens(usage.output_tokens)} output`,
  );
  L.push(
    `  ${usage.turns} turns · ${usage.tool_calls} tool calls · ${usage.edits} edits · ${usage.reads} reads · thinking ${usage.extended_thinking_used ? "yes" : "no"}`,
  );
  L.push("");
  L.push(`Profile: ${profile}`);
  L.push("");
  L.push(`oracle unreachable — pricing skipped (${err.message}). Session NOT logged.`);
  return L.join("\n");
}

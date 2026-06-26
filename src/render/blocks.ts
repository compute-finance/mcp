import { money, round, tokens } from "./format.js";
import { HistoryStats } from "../storage/history.js";

export interface CostBlockInput {
  effective_usd: number | null;
  nominal_usd: number | null;
  cache_note: string;
  cache_pricing_missing: { model: string; missing: string } | null;
}

export function renderCostBlock(input: CostBlockInput): string[] {
  const { effective_usd, nominal_usd, cache_note, cache_pricing_missing } =
    input;
  const lines: string[] = ["Cost (this session):"];

  if (effective_usd !== null && nominal_usd !== null) {
    lines.push(`  Effective (cache-aware):  ${money(effective_usd)}`);
    lines.push(`  Nominal (no cache):       ${money(nominal_usd)}`);
    const saved = round(nominal_usd - effective_usd, 4);
    const pct =
      nominal_usd > 0
        ? Math.round((saved / nominal_usd) * 100)
        : 0;
    const suffix = pct > 0 ? `   (−${pct}%)` : "";
    lines.push(`  Saved by caching:         ${money(saved)}${suffix}`);
    if (cache_note) lines.push(`  ${cache_note}`);
    return lines;
  }

  if (cache_pricing_missing !== null && nominal_usd !== null) {
    lines.push(`  Nominal (no cache discount):  ${money(nominal_usd)}`);
    lines.push(
      `  Effective (cache-aware):      unavailable — oracle has not published ${cache_pricing_missing.missing} pricing for ${cache_pricing_missing.model}`,
    );
    return lines;
  }

  lines.push(
    "  Current model not tracked by oracle — effective cost unavailable.",
  );
  return lines;
}

export interface OverheadBlockInput {
  fixed_overhead_tokens: number;
  inferences: number;
  scu_usd: number;
  cached_input_usd_per_million: number;
}

export function renderOverheadBlock(input: OverheadBlockInput): string[] {
  const {
    fixed_overhead_tokens,
    inferences,
    scu_usd,
    cached_input_usd_per_million,
  } = input;
  if (
    fixed_overhead_tokens <= 0 ||
    inferences < 2 ||
    scu_usd <= 0 ||
    cached_input_usd_per_million <= 0
  ) {
    return [];
  }

  const per_turn_usd =
    (fixed_overhead_tokens * cached_input_usd_per_million) / 1_000_000;
  const per_turn_scu = per_turn_usd / scu_usd;
  const total_scu = per_turn_scu * inferences;
  const total_usd = per_turn_usd * inferences;
  const per_turn_scu_str =
    per_turn_scu < 10
      ? per_turn_scu.toFixed(1)
      : Math.round(per_turn_scu).toLocaleString("en-US");

  return [
    `Context overhead — paid every inference (×${inferences} this session):`,
    `  fixed overhead    ${per_turn_scu_str} SCU/turn  →  ×${inferences} = ${tokens(total_scu)} SCU (${money(total_usd)})`,
  ];
}

export interface HistoryBlockInput {
  stats: HistoryStats;
  profile: string;
  effective_usd: number | null;
}

export function renderHistoryBlock(input: HistoryBlockInput): string[] {
  const { stats, profile, effective_usd } = input;
  if (stats.sample_size < 3) return [];

  const lines: string[] = [
    `Your history (n=${stats.distinct_sessions} sessions · ${money(stats.cumulative_effective_usd)} effective cumulative, ${money(stats.cumulative_nominal_usd)} nominal):`,
  ];

  const prof = stats.by_profile[profile];
  if (prof && prof.median_effective_usd > 0 && effective_usd !== null) {
    const ratio = effective_usd / prof.median_effective_usd - 1;
    const direction = ratio >= 0 ? "above" : "below";
    lines.push(
      `  This profile (${profile}): median ${money(prof.median_effective_usd)}  ·  this session ${money(effective_usd)}  →  ${Math.abs(Math.round(ratio * 100))}% ${direction} typical`,
    );
  }

  return lines;
}

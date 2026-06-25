import { money, round } from "./format.js";
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

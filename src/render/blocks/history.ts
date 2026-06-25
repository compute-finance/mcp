import { money } from "../format.js";
import { HistoryStats } from "../../storage/history.js";

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

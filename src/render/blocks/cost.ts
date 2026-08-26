import { money, round } from "../format.js";

export interface CostBlockInput {
  effective_usd: number | null;
  nominal_usd: number | null;
  cache_multipliers_note: string | null;
  cache_pricing_missing: { model: string; missing: string } | null;
}

export function renderCostBlock(input: CostBlockInput): string[] {
  const {
    effective_usd,
    nominal_usd,
    cache_multipliers_note,
    cache_pricing_missing,
  } = input;
  const lines: string[] = ["Cost (this session):"];

  if (effective_usd !== null && nominal_usd !== null) {
    if (cache_multipliers_note === null) {
      lines.push(
        `  Nominal (no cache):       ${money(nominal_usd)}  ·  oracle publishes no cache pricing for this model`,
      );
      return lines;
    }
    lines.push(`  Effective (cache-aware):  ${money(effective_usd)}`);
    lines.push(`  Nominal (no cache):       ${money(nominal_usd)}`);
    const saved = round(nominal_usd - effective_usd, 4);
    const pct =
      nominal_usd > 0 ? Math.round((saved / nominal_usd) * 100) : 0;
    const suffix = pct > 0 ? `   (−${pct}%)` : "";
    lines.push(`  Saved by caching:         ${money(saved)}${suffix}`);
    lines.push(`  ${cache_multipliers_note}`);
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

import { money } from "../format.js";

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
  const formatScu = (n: number) =>
    n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString("en-US");
  const per_turn_scu_str = formatScu(per_turn_scu);
  const total_scu_str = formatScu(total_scu);

  return [
    `Context overhead — paid every inference (×${inferences} this session):`,
    `  fixed overhead    ${per_turn_scu_str} SCU/turn  →  ×${inferences} = ${total_scu_str} SCU (${money(total_usd)})`,
  ];
}

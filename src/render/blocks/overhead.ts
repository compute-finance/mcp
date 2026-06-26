import { money, tokens } from "../format.js";

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

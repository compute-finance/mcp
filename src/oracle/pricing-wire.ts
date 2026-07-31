import { costUsd } from "./pricing.js";
import { applyRoutingFee } from "./routing-fee.js";
import { round } from "../render/format.js";
import type { ModelPrice } from "./types.js";

export const PRICING_NOTE =
  "base_* is the provider list price, identical for every model the oracle tracks. " +
  "billed_* is what compute.finance charges = base × (1 + routing_fee_rate). " +
  "Compare models on base_*; budget on billed_*. " +
  "billed_* is null when the oracle does not publish routing_fee_rate.";

export interface BilledPrices {
  billed_input_usd_per_million: number | null;
  billed_output_usd_per_million: number | null;
  billed_input_wei_per_million: number | null;
  billed_output_wei_per_million: number | null;
}

function billed(base: number | null, rate: number | null): number | null {
  return base === null || rate === null ? null : applyRoutingFee(base, rate);
}

export function withBilledPrices(
  price: ModelPrice,
  rate: number | null,
): ModelPrice & BilledPrices {
  return {
    ...price,
    billed_input_usd_per_million: billed(price.base_input_usd_per_million, rate),
    billed_output_usd_per_million: billed(price.base_output_usd_per_million, rate),
    billed_input_wei_per_million: billed(price.base_input_wei_per_million, rate),
    billed_output_wei_per_million: billed(price.base_output_wei_per_million, rate),
  };
}

export interface UsdCost {
  base_usd_cost: number;
  routing_fee_usd: number | null;
  billed_usd_cost: number | null;
}

export function usdCost(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
  rate: number | null,
): UsdCost {
  const base_usd_cost = round(costUsd(price, inputTokens, outputTokens), 6);
  if (rate === null) {
    return { base_usd_cost, routing_fee_usd: null, billed_usd_cost: null };
  }
  const billed_usd_cost = round(applyRoutingFee(base_usd_cost, rate), 6);
  return {
    base_usd_cost,
    routing_fee_usd: round(billed_usd_cost - base_usd_cost, 6),
    billed_usd_cost,
  };
}

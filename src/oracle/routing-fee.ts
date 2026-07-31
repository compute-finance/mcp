import { getCpi } from "./client.js";
import { getFieldMap } from "./field-map.js";
import { trimFloatNoise } from "../render/format.js";

export function applyRoutingFee(baseUsd: number, rate: number): number {
  return trimFloatNoise(baseUsd * (1 + rate));
}

export async function getRoutingFeeRate(): Promise<number | null> {
  try {
    const basket = (await getCpi()) as Record<string, unknown> | null;
    if (!basket || typeof basket !== "object") return null;
    const rate = basket[getFieldMap().basket.routing_fee_rate];
    return typeof rate === "number" && isFinite(rate) && rate >= 0 ? rate : null;
  } catch {
    return null;
  }
}

import {
  getBasketPrices,
  effectiveCost,
  resolveCanonicalIn,
} from "../oracle/client.js";
import { findLatestSessionFile, parseSessionUsage } from "../storage/session.js";
import { parseTurns } from "../storage/turns.js";
import { round } from "../render/format.js";

export interface SessionContext {
  turns_so_far: number;
  cost_so_far_usd: number;
  most_expensive_turn: { turn: number; cost: number } | null;
}

let cached: { ctx: SessionContext; at: number } | null = null;
const CACHE_TTL_MS = 30_000;

export async function getSessionContext(): Promise<SessionContext | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ctx;

  try {
    const path = findLatestSessionFile();
    if (!path) return null;
    const usage = parseSessionUsage(path);
    if (usage.turns < 1) return null;

    const basket = await getBasketPrices();
    const normalized = resolveCanonicalIn(usage.model, basket);
    const price = normalized
      ? (basket.find((p) => p.model === normalized) ?? null)
      : null;

    let cost_so_far = 0;
    if (price) {
      cost_so_far = effectiveCost(
        price,
        usage.raw_input_tokens,
        usage.cache_read_tokens,
        usage.cache_creation_tokens,
        usage.output_tokens,
      ).effective_usd;
    }

    let mostExpensive: { turn: number; cost: number } | null = null;
    if (price && usage.turns >= 2) {
      try {
        const turnData = parseTurns(path);
        let maxCost = 0;
        let maxIdx = 0;
        for (const t of turnData.turns) {
          const tc = effectiveCost(
            price,
            t.raw_input_tokens,
            t.cache_read_tokens,
            t.cache_creation_tokens,
            t.output_tokens,
          ).effective_usd;
          if (tc > maxCost) {
            maxCost = tc;
            maxIdx = t.turn_index;
          }
        }
        if (maxCost > 0) {
          mostExpensive = { turn: maxIdx, cost: round(maxCost, 4) };
        }
      } catch { /* non-critical */ }
    }

    const ctx: SessionContext = {
      turns_so_far: usage.turns,
      cost_so_far_usd: round(cost_so_far, 4),
      most_expensive_turn: mostExpensive,
    };
    cached = { ctx, at: Date.now() };
    return ctx;
  } catch {
    return null;
  }
}

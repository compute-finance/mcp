import {
  priceSession,
  resolveModel,
  resolvedToModelPrice,
} from "../oracle/client.js";
import {
  findLatestSessionFile,
  parseTranscript,
} from "../storage/transcript.js";
import { summarizeSession } from "../storage/session.js";
import { round } from "../render/format.js";

export interface SessionContext {
  prompts_so_far: number;
  inferences_so_far: number;
  cost_so_far_usd: number;
  most_expensive_inference: { index: number; cost: number } | null;
}

let cached: { ctx: SessionContext; at: number } | null = null;
const CACHE_TTL_MS = 30_000;

export async function getSessionContext(): Promise<SessionContext | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ctx;

  try {
    const path = findLatestSessionFile();
    if (!path) return null;
    const transcript = parseTranscript(path);
    const usage = summarizeSession(transcript);
    if (usage.prompts < 1) return null;

    const resolved = await resolveModel(usage.model);
    const price =
      resolved && resolved.price_source !== "off-basket"
        ? resolvedToModelPrice(resolved)
        : null;

    let cost_so_far = 0;
    if (price) {
      const r = priceSession(
        price,
        usage.raw_input_tokens,
        usage.cache_read_tokens,
        usage.cache_creation_tokens,
        usage.output_tokens,
      );
      if (!r.effective) return null;
      cost_so_far = r.effective.effective_usd;
    }

    let mostExpensive: { index: number; cost: number } | null = null;
    if (price && transcript.inferences.length >= 2) {
      let maxCost = 0;
      let maxIdx = 0;
      for (const inf of transcript.inferences) {
        const r = priceSession(
          price,
          inf.raw_input_tokens,
          inf.cache_read_tokens,
          inf.cache_creation_tokens,
          inf.output_tokens,
        );
        if (!r.effective) return null;
        if (r.effective.effective_usd > maxCost) {
          maxCost = r.effective.effective_usd;
          maxIdx = inf.index;
        }
      }
      if (maxCost > 0) {
        mostExpensive = { index: maxIdx, cost: round(maxCost, 4) };
      }
    }

    const ctx: SessionContext = {
      prompts_so_far: usage.prompts,
      inferences_so_far: usage.inferences,
      cost_so_far_usd: round(cost_so_far, 4),
      most_expensive_inference: mostExpensive,
    };
    cached = { ctx, at: Date.now() };
    return ctx;
  } catch {
    return null;
  }
}

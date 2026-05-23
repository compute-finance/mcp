import {
  getBasketPrices,
  costUsd,
  effectiveCost,
  resolveCanonicalIn,
} from "../oracle/client.js";
import {
  findSessionFile,
  findLatestSessionFile,
  parseSessionUsage,
} from "../storage/session.js";
import { logSession, getStats } from "../storage/history.js";
import { parseTurns, logTurns } from "../storage/turns.js";
import { classifyProfile } from "../storage/profile.js";
import { round } from "../render/format.js";
import { checkOptionalSessionId, optionalString } from "./validation.js";

function resolveSessionArgs(a: Record<string, unknown>): string | null | { error: string } {
  const sidCheck = checkOptionalSessionId(a.session_id);
  if (sidCheck && typeof sidCheck === "object") return sidCheck;
  const cwdCheck = optionalString(a.cwd, "cwd");
  if (typeof cwdCheck === "object" && cwdCheck !== null) return cwdCheck;

  const path = sidCheck
    ? findSessionFile(sidCheck, cwdCheck)
    : findLatestSessionFile(cwdCheck);
  if (!path) return { error: "No session transcript found" };
  return path;
}

export async function rawAnalyzeSession(a: Record<string, unknown>) {
  const pathOrError = resolveSessionArgs(a);
  if (typeof pathOrError === "object" && pathOrError !== null) return pathOrError;
  const path = pathOrError as string;

  const usage = parseSessionUsage(path);
  const basket = await getBasketPrices();
  const normalized = resolveCanonicalIn(usage.model, basket);
  const totalIn =
    usage.raw_input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
  const counterfactual = basket
    .map((p) => ({
      model: p.model,
      provider: p.provider,
      tier: p.tier,
      usd_cost: round(costUsd(p, totalIn, usage.output_tokens), 6),
    }))
    .sort((x, y) => x.usd_cost - y.usd_cost);

  let current: unknown = null;
  let effective_usd: number | null = null;
  let nominal_usd: number | null = null;
  if (normalized) {
    const price = basket.find((p) => p.model === normalized) ?? null;
    if (price) {
      const eff = effectiveCost(
        price,
        usage.raw_input_tokens,
        usage.cache_read_tokens,
        usage.cache_creation_tokens,
        usage.output_tokens,
      );
      effective_usd = round(eff.effective_usd, 6);
      nominal_usd = round(eff.nominal_usd, 6);
      current = {
        model: normalized,
        effective_usd,
        nominal_usd,
        savings_from_cache_usd: round(eff.nominal_usd - eff.effective_usd, 6),
        breakdown: {
          raw_input_usd: round(eff.breakdown.raw_input_usd, 6),
          cache_read_usd: round(eff.breakdown.cache_read_usd, 6),
          cache_create_usd: round(eff.breakdown.cache_create_usd, 6),
          output_usd: round(eff.breakdown.output_usd, 6),
        },
        cache_source: eff.cache_source,
        notes: eff.notes,
      };
    }
  }

  const prof = classifyProfile(usage);

  logSession({
    session_id: usage.session_id,
    model: normalized,
    in_basket: normalized !== null,
    profile: prof.profile,
    raw_input_tokens: usage.raw_input_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    output_tokens: usage.output_tokens,
    turns: usage.turns,
    tool_calls: usage.tool_calls,
    edits: usage.edits,
    reads: usage.reads,
    extended_thinking_used: usage.extended_thinking_used,
    effective_usd,
    nominal_usd,
    out_in_ratio: prof.out_in_ratio,
  });

  return {
    session: {
      session_id: usage.session_id,
      cwd: usage.cwd,
      model_raw: usage.model,
      model_normalized: normalized,
      in_basket: normalized !== null,
    },
    usage: {
      raw_input_tokens: usage.raw_input_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_creation_tokens: usage.cache_creation_tokens,
      output_tokens: usage.output_tokens,
      turns: usage.turns,
      tool_calls: usage.tool_calls,
      edits: usage.edits,
      reads: usage.reads,
      extended_thinking_used: usage.extended_thinking_used,
    },
    current_model_cost: current,
    counterfactual_nominal: counterfactual,
    profile: prof,
    source: "api.compute.finance/v1/oracle/basket + local transcript",
  };
}

export async function rawAnalyzeTurns(a: Record<string, unknown>) {
  const pathOrError = resolveSessionArgs(a);
  if (typeof pathOrError === "object" && pathOrError !== null) return pathOrError;
  const path = pathOrError as string;

  const result = parseTurns(path);
  const basket = await getBasketPrices();
  const normalized = resolveCanonicalIn(result.model, basket);
  const price = normalized
    ? (basket.find((p) => p.model === normalized) ?? null)
    : null;
  const turnsWithCost = result.turns.map((t) => {
    let effective_usd: number | null = null;
    let nominal_usd: number | null = null;
    if (price) {
      const eff = effectiveCost(
        price,
        t.raw_input_tokens,
        t.cache_read_tokens,
        t.cache_creation_tokens,
        t.output_tokens,
      );
      effective_usd = round(eff.effective_usd, 6);
      nominal_usd = round(eff.nominal_usd, 6);
    }
    return { ...t, effective_usd, nominal_usd };
  });

  logTurns(result.turns);

  return {
    session_id: result.session_id,
    model: result.model,
    model_normalized: normalized,
    total_turns: result.total_turns,
    totals: result.totals,
    by_tool: result.by_tool,
    cache_hit_ratio: round(result.cache_hit_ratio, 3),
    turns: turnsWithCost,
    source: "api.compute.finance/v1/oracle/basket + local transcript",
  };
}

export async function getHistory() {
  const basket = await getBasketPrices();
  return getStats(basket);
}

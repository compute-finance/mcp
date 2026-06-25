import { tokens, money, round } from "../render/format.js";

export type HookComposeInputs =
  | {
      mode: "basket";
      effective_usd: number;
      nominal_usd: number;
      scu_usd: number;
      subscription: boolean;
    }
  | {
      mode: "off_basket";
      fresh_tokens: number;
      cached_tokens: number;
      cost_usd: number | null;
      subscription: boolean;
    };

const PREFIX = "💰 Compute.Finance";
const CACHE_MIN_PCT = 1;
const CACHE_MAX_PCT = 99;

function formatUsd(amount: number, subscription: boolean): string {
  const m = money(round(amount, 2));
  return subscription ? `~${m} API-equiv` : m;
}

function formatScuWithUsd(
  scu_usd: number,
  effective_usd: number,
  subscription: boolean,
): string {
  const scuCount = effective_usd / scu_usd;
  return `${tokens(scuCount)} SCU (${formatUsd(effective_usd, subscription)})`;
}

function formatCacheSaved(
  effective_usd: number,
  nominal_usd: number,
): string | null {
  if (nominal_usd <= 0) return null;
  const saved = (nominal_usd - effective_usd) / nominal_usd;
  if (saved <= 0) return null;
  const pct = Math.round(saved * 100);
  if (pct < CACHE_MIN_PCT) return null;
  return `cache saved ${Math.min(pct, CACHE_MAX_PCT)}%`;
}

function formatTokenSplit(fresh: number, cached: number): string {
  if (cached <= 0) return `${tokens(fresh)} fresh`;
  return `${tokens(fresh)} fresh / ${tokens(cached)} cached`;
}

export function composeHookLine(i: HookComposeInputs): string {
  const segments: string[] = [PREFIX];

  if (i.mode === "basket") {
    segments.push(formatScuWithUsd(i.scu_usd, i.effective_usd, i.subscription));
    const cache = formatCacheSaved(i.effective_usd, i.nominal_usd);
    if (cache !== null) segments.push(cache);
  } else {
    if (i.cost_usd !== null) {
      segments.push(formatUsd(i.cost_usd, i.subscription));
    }
    segments.push(formatTokenSplit(i.fresh_tokens, i.cached_tokens));
  }

  return segments.join(" · ");
}

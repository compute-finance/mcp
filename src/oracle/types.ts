// All model + price data is now sourced live from the Compute Finance API.
// No model lists, no per-model price constants in this file.
// `/v1/oracle/basket` is the canonical basket; `/v1/oracle/pricing` mirrors its prices.

export type Tier = "frontier" | "standard" | "lightweight";

export interface CacheMultipliers {
  read: number;
  write_5m: number;
  write_1h: number;
  // "oracle"          — every multiplier came from the oracle's cache block
  // "oracle-partial"  — oracle published some fields, others fell back locally
  // "local-fallback"  — no oracle cache block; all values from provider table
  source: "oracle" | "oracle-partial" | "local-fallback";
}

export interface ModelPrice {
  model: string;
  display_name: string;
  provider: string;
  provider_name: string;
  tier: Tier;
  integrated: boolean;
  released_at: string | null;
  input_usd_per_million: number;
  output_usd_per_million: number;
  input_wei_per_million: number;
  output_wei_per_million: number;
  cache: CacheMultipliers;
}

// Oracle API response types are intentionally absent. The Oracle can rename
// fields at any time (e.g. ct → wei); hardcoded interfaces would break.
// Fetch functions return `unknown`; the AI reads the OpenAPI-derived response
// schema in each tool description to interpret the raw JSON.
//
// Only the cache block shape is typed — it's consumed by mergeCache() which
// needs to inspect individual multiplier fields.

export interface OracleCacheBlock {
  readMultiplier?: number;
  writeMultiplier?: number;
  writeMultiplier5m?: number;
  writeMultiplier1h?: number;
}

// Provider-level cache multiplier fallbacks. This is the ONLY place provider
// names are baked in. New provider added to the oracle = it inherits the
// "default" entry until verified values are added here. Not per-model — a
// provider's caching mechanism is a property of the provider.
//
// Verified against live docs on 2026-04-14:
// - Anthropic: https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
//   reads 0.1× input · 5m writes 1.25× · 1h writes 2.0×
// - OpenAI: https://developers.openai.com/api/docs/pricing (gpt-4.1/gpt-5 family)
//   reads 0.1× input · no write premium
// - Google/xAI: cache_*_tokens are not currently surfaced by Claude Code
//   transcripts for these providers, so multipliers don't materially affect
//   computed costs. Conservative default = 1.0× until verified.
export const CACHE_FALLBACKS_BY_PROVIDER: Record<
  string,
  Omit<CacheMultipliers, "source">
> = {
  anthropic: { read: 0.1, write_5m: 1.25, write_1h: 2.0 },
  openai: { read: 0.1, write_5m: 1.0, write_1h: 1.0 },
  google: { read: 1.0, write_5m: 1.0, write_1h: 1.0 },
  xai: { read: 1.0, write_5m: 1.0, write_1h: 1.0 },
};

export const DEFAULT_CACHE_FALLBACK: Omit<CacheMultipliers, "source"> = {
  read: 1.0,
  write_5m: 1.0,
  write_1h: 1.0,
};

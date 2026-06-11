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
  // "local-fallback"  — no oracle cache block; values from the neutral default
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

// Cache multipliers come from the oracle's per-model `cache` block
// (/v1/oracle/pricing). DEFAULT_CACHE_FALLBACK is the neutral safety net for a
// model the oracle hasn't published multipliers for yet (unknown provider, or a
// partial cache block) — 1.0× leaves cost unchanged rather than guessing.
export const DEFAULT_CACHE_FALLBACK: Omit<CacheMultipliers, "source"> = {
  read: 1.0,
  write_5m: 1.0,
  write_1h: 1.0,
};

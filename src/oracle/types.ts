export type Tier = "frontier" | "standard" | "lightweight";

export interface CachePriceComponent {
  usdPerMillion: number;
  ratioOfInput: number;
  source: string;
  sourceUrl: string | null;
  createdAt: string;
}

export interface CachePricing {
  cachedInput: CachePriceComponent | null;
  cacheWrite5m: CachePriceComponent | null;
  cacheWrite1h: CachePriceComponent | null;
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
  cache: CachePricing | null;
}

export interface OracleCacheComponentWire {
  usdPerMillion: number | null;
  ratioOfInput: number | null;
  source: string;
  sourceUrl: string | null;
  createdAt: string;
}

export interface OracleCacheBlock {
  cachedInput: OracleCacheComponentWire | null;
  cacheWrite5m: OracleCacheComponentWire | null;
  cacheWrite1h: OracleCacheComponentWire | null;
}

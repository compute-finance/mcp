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
  family: string;
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

export type PriceSource = "oracle-basket" | "oracle-catalog" | "off-basket";

export interface ResolvedModel {
  input_key: string;
  resolved_key: string;
  family: string | null;
  provider: { key: string; name: string } | null;
  input_usd_per_million: number | null;
  output_usd_per_million: number | null;
  cache: CachePricing | null;
  in_basket: boolean;
  price_source: PriceSource;
}

export type PriceProvenance = "verified" | "inferred" | "promotional";

export type CacheComponentKind = "cachedInput" | "cacheWrite5m" | "cacheWrite1h";

export type PriceComponentKind = CacheComponentKind | "reasoningOutput";

export interface PriceComponent {
  usdPerMillion: number;
  ratioOfInput: number;
  provenance: PriceProvenance;
  createdAt: string | null;
}

export interface CachePricing {
  cachedInput: PriceComponent | null;
  cacheWrite5m: PriceComponent | null;
  cacheWrite1h: PriceComponent | null;
}

export interface ReasoningPricing {
  reasoningOutput: PriceComponent | null;
}

export interface BasePriceProvenance {
  input: PriceProvenance;
  output: PriceProvenance;
}

export interface ModelPrice {
  model: string;
  display_name: string;
  provider: string;
  provider_name: string;
  family: string;
  released_at: string | null;
  base_input_usd_per_million: number;
  base_output_usd_per_million: number;
  base_input_wei_per_million: number | null;
  base_output_wei_per_million: number | null;
  cache: CachePricing | null;
  reasoning: ReasoningPricing | null;
}

export interface OraclePriceComponentWire {
  usdPerMillion: number | null;
  ratioOfInput: number | null;
  provenance: PriceProvenance;
  createdAt: string | null;
}

export interface OracleCacheBlock {
  cachedInput: OraclePriceComponentWire | null;
  cacheWrite5m: OraclePriceComponentWire | null;
  cacheWrite1h: OraclePriceComponentWire | null;
}

export interface OracleReasoningBlock {
  reasoningOutput: OraclePriceComponentWire | null;
}

export type PriceSource = "oracle-basket" | "oracle-catalog" | "off-basket";

export interface ResolvedModel {
  input_key: string;
  resolved_key: string;
  family: string | null;
  provider: { key: string; name: string } | null;
  base_input_usd_per_million: number | null;
  base_output_usd_per_million: number | null;
  base_price_provenance: BasePriceProvenance | null;
  cache: CachePricing | null;
  reasoning: ReasoningPricing | null;
  in_basket: boolean;
  price_source: PriceSource;
}

// `family` matches ModelPrice.family (same keyspace) — the join key for blended-price lookup.
export interface ScuFamilyRepresentative {
  family: string;
  modelKey: string;
  inputPriceUsdPerMillion: number;
  outputPriceUsdPerMillion: number;
  blendedCostUsd: number;
}

export interface ScuValue {
  scuUsd: number;
  computeIndex: number | null;
  methodologyVersion: number;
  updatedAt: string;
  familyRepresentatives: ScuFamilyRepresentative[];
}

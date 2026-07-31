import { CachePriceComponent, CachePricing, ModelPrice } from "./types.js";

export type CacheComponentKind = "cachedInput" | "cacheWrite5m" | "cacheWrite1h";

export class OracleCachePricingMissingError extends Error {
  constructor(
    public readonly model: string,
    public readonly missing: "block" | CacheComponentKind,
  ) {
    const what =
      missing === "block"
        ? "a cache pricing block"
        : `${missing} pricing`;
    super(
      `Oracle has not published ${what} for ${model}. ` +
        "Cache tokens cannot be priced without it.",
    );
    this.name = "OracleCachePricingMissingError";
  }
}

export function costUsd(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * price.base_input_usd_per_million +
    (outputTokens / 1_000_000) * price.base_output_usd_per_million
  );
}

export function nominalCost(
  price: ModelPrice,
  rawIn: number,
  cacheRead: number,
  cacheCreate: number,
  out: number,
): number {
  const inPerTok = price.base_input_usd_per_million / 1_000_000;
  const outPerTok = price.base_output_usd_per_million / 1_000_000;
  return (rawIn + cacheRead + cacheCreate) * inPerTok + out * outPerTok;
}

export interface EffectiveCost {
  nominal_usd: number;
  effective_usd: number;
  breakdown: {
    raw_input_usd: number;
    cache_read_usd: number;
    cache_create_usd: number;
    output_usd: number;
  };
  cache_attribution: CachePricing | null;
  notes: string[];
}

function formatSource(c: CachePriceComponent): string {
  return c.sourceUrl ? `${c.source} — ${c.sourceUrl}` : c.source;
}

function buildAttributionNotes(cache: CachePricing | null): string[] {
  if (cache === null) {
    return ["Cache pricing unavailable — oracle has not published a cache block for this model."];
  }
  const parts: string[] = [];
  if (cache.cachedInput) {
    parts.push(`read ${cache.cachedInput.ratioOfInput}× (${formatSource(cache.cachedInput)})`);
  }
  if (cache.cacheWrite5m) {
    parts.push(`write-5m ${cache.cacheWrite5m.ratioOfInput}× (${formatSource(cache.cacheWrite5m)})`);
  }
  if (cache.cacheWrite1h) {
    parts.push(`write-1h ${cache.cacheWrite1h.ratioOfInput}× (${formatSource(cache.cacheWrite1h)})`);
  }
  if (parts.length === 0) {
    return ["Cache pricing unavailable — oracle published an empty cache block for this model."];
  }
  return [`Oracle cache multipliers: ${parts.join(" · ")}`];
}

export function effectiveCost(
  price: ModelPrice,
  rawIn: number,
  cacheRead: number,
  cacheCreate: number,
  out: number,
): EffectiveCost {
  const inPerTok = price.base_input_usd_per_million / 1_000_000;
  const outPerTok = price.base_output_usd_per_million / 1_000_000;

  if ((cacheRead > 0 || cacheCreate > 0) && price.cache === null) {
    throw new OracleCachePricingMissingError(price.model, "block");
  }
  if (cacheRead > 0 && price.cache!.cachedInput === null) {
    throw new OracleCachePricingMissingError(price.model, "cachedInput");
  }
  // Claude Code transcripts don't split 5m vs 1h cache creates — price as 5m (its default TTL).
  if (cacheCreate > 0 && price.cache!.cacheWrite5m === null) {
    throw new OracleCachePricingMissingError(price.model, "cacheWrite5m");
  }

  const raw_input_usd = rawIn * inPerTok;
  const cache_read_usd =
    cacheRead > 0 ? cacheRead * (price.cache!.cachedInput!.usdPerMillion / 1_000_000) : 0;
  const cache_create_usd =
    cacheCreate > 0 ? cacheCreate * (price.cache!.cacheWrite5m!.usdPerMillion / 1_000_000) : 0;
  const output_usd = out * outPerTok;

  const nominal_usd = nominalCost(price, rawIn, cacheRead, cacheCreate, out);
  const effective_usd = raw_input_usd + cache_read_usd + cache_create_usd + output_usd;

  return {
    nominal_usd,
    effective_usd,
    breakdown: {
      raw_input_usd,
      cache_read_usd,
      cache_create_usd,
      output_usd,
    },
    cache_attribution: price.cache,
    notes: buildAttributionNotes(price.cache),
  };
}

export interface PricedSession {
  nominal_usd: number;
  effective: EffectiveCost | null;
  cache_pricing_missing: OracleCachePricingMissingError | null;
}

export function priceSession(
  price: ModelPrice,
  rawIn: number,
  cacheRead: number,
  cacheCreate: number,
  out: number,
): PricedSession {
  const nominal_usd = nominalCost(price, rawIn, cacheRead, cacheCreate, out);
  try {
    const effective = effectiveCost(price, rawIn, cacheRead, cacheCreate, out);
    return { nominal_usd, effective, cache_pricing_missing: null };
  } catch (err) {
    if (!(err instanceof OracleCachePricingMissingError)) throw err;
    return { nominal_usd, effective: null, cache_pricing_missing: err };
  }
}

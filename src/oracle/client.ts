import {
  CACHE_FALLBACKS_BY_PROVIDER,
  CacheMultipliers,
  DEFAULT_CACHE_FALLBACK,
  ModelPrice,
  OracleCacheBlock,
  Tier,
} from "./types.js";
import { getFieldMap } from "./field-map.js";

const API_BASE = process.env.CF_API_BASE ?? "https://api.compute.finance";

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
let cpiCache: CacheEntry<unknown> | null = null;
let pricingCache: CacheEntry<unknown> | null = null;
let scuCache: CacheEntry<unknown> | null = null;
let tiersCache: CacheEntry<unknown> | null = null;
let reconstitutionsCache: CacheEntry<unknown> | null = null;
// Composed basket cache: avoid re-running mergeCache for every model on every
// call when the underlying CPI + pricing caches are warm. getBasketPrices()
// is called multiple times per render invocation.
let basketCache: CacheEntry<ModelPrice[]> | null = null;
// Memoise the canonical-id Set per basket array reference so resolveCanonicalIn
// callers in tight loops don't rebuild it. WeakMap = the Set is GC'd as soon
// as the basket array goes out of scope.
const idsByBasket = new WeakMap<ModelPrice[], Set<string>>();

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Oracle ${path} returned ${res.status}`);
  }
  return res.json();
}

// ── Raw Oracle pass-through (no typed shapes) ───────────────────────
// These return `unknown` — the AI reads the OpenAPI-derived response
// schema in each tool description to interpret the JSON.

export async function getCpi(): Promise<unknown> {
  if (cpiCache && Date.now() - cpiCache.fetchedAt < CACHE_TTL_MS) {
    return cpiCache.data;
  }
  const data = await fetchJson("/v1/oracle/basket");
  cpiCache = { data, fetchedAt: Date.now() };
  return data;
}

async function getPricing(): Promise<unknown> {
  if (pricingCache && Date.now() - pricingCache.fetchedAt < CACHE_TTL_MS) {
    return pricingCache.data;
  }
  const data = await fetchJson("/v1/oracle/pricing");
  pricingCache = { data, fetchedAt: Date.now() };
  return data;
}

export async function getScu(): Promise<unknown> {
  if (scuCache && Date.now() - scuCache.fetchedAt < CACHE_TTL_MS) {
    return scuCache.data;
  }
  const data = await fetchJson("/v1/oracle/scu");
  scuCache = { data, fetchedAt: Date.now() };
  return data;
}

export async function getTiers(): Promise<unknown> {
  if (tiersCache && Date.now() - tiersCache.fetchedAt < CACHE_TTL_MS) {
    return tiersCache.data;
  }
  const data = await fetchJson("/v1/oracle/tiers");
  tiersCache = { data, fetchedAt: Date.now() };
  return data;
}

export async function getReconstitutions(): Promise<unknown> {
  if (
    reconstitutionsCache &&
    Date.now() - reconstitutionsCache.fetchedAt < CACHE_TTL_MS
  ) {
    return reconstitutionsCache.data;
  }
  const data = await fetchJson("/v1/oracle/reconstitutions");
  reconstitutionsCache = { data, fetchedAt: Date.now() };
  return data;
}

// ── Typed internal helpers ──────────────────────────────────────────
// Safe accessors for the specific fields getBasketPrices() needs from
// the raw CPI + pricing JSON. If the Oracle renames these, only this
// block needs updating — no interface cascade.

type AnyModel = Record<string, unknown>;
type AnyPricing = Record<string, unknown>;

function cpiModels(cpi: unknown, arrayField: string): AnyModel[] {
  const c = cpi as Record<string, unknown>;
  return (c[arrayField] ?? []) as AnyModel[];
}

function pricingCacheBlock(pricing: unknown, modelId: string): OracleCacheBlock | undefined {
  if (!pricing) return undefined;
  const p = pricing as AnyPricing;
  const models = p.models as Record<string, AnyPricing> | undefined;
  return models?.[modelId]?.cache as OracleCacheBlock | undefined;
}

function inputOutput(obj: unknown): { input: number; output: number } {
  if (!obj || typeof obj !== "object") return { input: 0, output: 0 };
  const o = obj as Record<string, number>;
  return { input: o.input ?? 0, output: o.output ?? 0 };
}

function mergeCache(
  providerKey: string,
  oracleBlock: OracleCacheBlock | undefined,
): CacheMultipliers {
  const fallback =
    CACHE_FALLBACKS_BY_PROVIDER[providerKey] ?? DEFAULT_CACHE_FALLBACK;
  if (!oracleBlock) return { ...fallback, source: "local-fallback" };
  const readFromOracle = oracleBlock.read_multiplier !== undefined;
  const writeShorthandFromOracle = oracleBlock.write_multiplier !== undefined;
  const write5mFromOracle =
    oracleBlock.write_multiplier_5m !== undefined || writeShorthandFromOracle;
  const write1hFromOracle =
    oracleBlock.write_multiplier_1h !== undefined || writeShorthandFromOracle;
  const read = oracleBlock.read_multiplier ?? fallback.read;
  const write_5m =
    oracleBlock.write_multiplier_5m ??
    oracleBlock.write_multiplier ??
    fallback.write_5m;
  const write_1h =
    oracleBlock.write_multiplier_1h ??
    oracleBlock.write_multiplier ??
    fallback.write_1h;
  const allFromOracle =
    readFromOracle && write5mFromOracle && write1hFromOracle;
  return {
    read,
    write_5m,
    write_1h,
    source: allFromOracle ? "oracle" : "oracle-partial",
  };
}

// ── Basket (typed internal representation) ──────────────────────────
//
// Build the canonical basket from /v1/oracle/basket. CPI is the source of truth
// for which models exist and what tier/provider they belong to. /v1/oracle/pricing is
// queried in parallel only to surface any per-model `cache` block the oracle
// publishes — falls back to provider-keyed defaults when absent.
//
// The composed array is itself cached for CACHE_TTL_MS so the per-model
// mergeCache() loop doesn't re-run on every call when the underlying caches
// are warm.

export async function getBasketPrices(): Promise<ModelPrice[]> {
  if (basketCache && Date.now() - basketCache.fetchedAt < CACHE_TTL_MS) {
    return basketCache.data;
  }
  const fm = getFieldMap().basket;
  const [cpi, pricing] = await Promise.all([
    getCpi(),
    getPricing().catch(() => null),
  ]);
  const out: ModelPrice[] = [];
  for (const m of cpiModels(cpi, fm.models_array)) {
    const id = m[fm.model_id] as string;
    if (!id) continue;
    const providerObj = m[fm.provider] as Record<string, unknown> | undefined;
    const providerKey = (providerObj?.[fm.provider_key] as string) ?? "unknown";
    const providerName = (providerObj?.[fm.provider_name] as string) ?? providerKey;
    const cacheBlock = pricingCacheBlock(pricing, id);
    const markedUpUsd = inputOutput(m[fm.marked_up_usd_price]);
    const markedUpWei = inputOutput(m[fm.marked_up_wei_price]);
    out.push({
      model: id,
      display_name: (m[fm.display_name] as string) ?? id,
      provider: providerKey,
      provider_name: providerName,
      tier: (m[fm.tier] as Tier) ?? "standard",
      integrated: (m[fm.integrated] as boolean) ?? false,
      released_at: (m[fm.released_at] as string | null) ?? null,
      input_usd_per_million: markedUpUsd.input,
      output_usd_per_million: markedUpUsd.output,
      input_wei_per_million: markedUpWei.input,
      output_wei_per_million: markedUpWei.output,
      cache: mergeCache(providerKey, cacheBlock),
    });
  }
  basketCache = { data: out, fetchedAt: Date.now() };
  return out;
}

export async function getModelPrice(model: string): Promise<ModelPrice | null> {
  const all = await getBasketPrices();
  return all.find((m) => m.model === model) ?? null;
}

// Resolve a raw model string (e.g. from a Claude Code transcript) to a
// canonical basket model id. Pure algorithmic — no per-model alias table —
// so newly-listed models are matchable the moment the oracle adds them.
//
// Heuristics, in order:
//   1. Direct hit on the basket id.
//   2. Strip bracket metadata (`[1m]`) and trailing date suffixes (`-20251001`).
//   3. Try every `digit-digit` boundary as a candidate dot replacement
//      (`claude-opus-4-7` → `claude-opus-4.7`). First-match-wins, leftmost.
//
// Assumption: every canonical id in the basket has at most ONE dot in its
// version segment (e.g. `claude-opus-4.7`, `gpt-5.4`, `gemini-3.1-pro`). The
// loop substitutes one hyphen-between-digits at a time, so an input that
// ought to map to a multi-dot id (e.g. `gpt-5-1-mini` → `gpt-5.1.mini`) would
// not resolve. If the oracle ever adopts multi-dot ids, the loop needs to
// branch — for now this matches every canonical id in the live basket.
function canonicalizeIn(raw: string, ids: Set<string>): string | null {
  if (ids.has(raw)) return raw;
  const stripped = raw.replace(/\[[^\]]+\]/g, "").replace(/-\d{8,}$/, "");
  if (ids.has(stripped)) return stripped;
  // Walk each `\d-\d` boundary, replace with dot, check.
  for (let i = 1; i < stripped.length - 1; i++) {
    if (
      stripped[i] === "-" &&
      /\d/.test(stripped[i - 1]) &&
      /\d/.test(stripped[i + 1])
    ) {
      const candidate = stripped.slice(0, i) + "." + stripped.slice(i + 1);
      if (ids.has(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveCanonicalIn(
  raw: string | null | undefined,
  basket: ModelPrice[],
): string | null {
  if (!raw) return null;
  let ids = idsByBasket.get(basket);
  if (!ids) {
    ids = new Set(basket.map((b) => b.model));
    idsByBasket.set(basket, ids);
  }
  return canonicalizeIn(raw, ids);
}

// Convenience wrapper that fetches the basket internally. Returns null if the
// oracle is unreachable — callers can treat that the same as "off-basket".
export async function resolveCanonical(
  raw: string | null | undefined,
): Promise<string | null> {
  if (!raw) return null;
  let basket: ModelPrice[];
  try {
    basket = await getBasketPrices();
  } catch {
    return null;
  }
  return resolveCanonicalIn(raw, basket);
}

export function costUsd(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * price.input_usd_per_million +
    (outputTokens / 1_000_000) * price.output_usd_per_million
  );
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
  cache_source: CacheMultipliers["source"];
  notes: string[];
}

export function effectiveCost(
  price: ModelPrice,
  rawIn: number,
  cacheRead: number,
  cacheCreate: number,
  out: number,
): EffectiveCost {
  const in_per_tok = price.input_usd_per_million / 1_000_000;
  const out_per_tok = price.output_usd_per_million / 1_000_000;

  const nominal_usd =
    (rawIn + cacheRead + cacheCreate) * in_per_tok + out * out_per_tok;

  const raw_input_usd = rawIn * in_per_tok;
  const cache_read_usd = cacheRead * in_per_tok * price.cache.read;
  // Claude Code's default TTL is 5m; a 1h-write-aware breakdown will become
  // possible once transcripts distinguish the two — the multiplier is already
  // surfaced in price.cache.write_1h.
  const cache_create_usd = cacheCreate * in_per_tok * price.cache.write_5m;
  const output_usd = out * out_per_tok;
  const effective_usd =
    raw_input_usd + cache_read_usd + cache_create_usd + output_usd;

  const notes = [
    `cache multipliers (${price.cache.source}): read ${price.cache.read}× · write-5m ${price.cache.write_5m}× · write-1h ${price.cache.write_1h}×`,
  ];

  return {
    nominal_usd,
    effective_usd,
    breakdown: {
      raw_input_usd,
      cache_read_usd,
      cache_create_usd,
      output_usd,
    },
    cache_source: price.cache.source,
    notes,
  };
}

// Re-export Tier so consumers don't have to import it from types.ts directly.
export type { Tier };

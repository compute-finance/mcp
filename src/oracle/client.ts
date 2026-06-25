import {
  CachePriceComponent,
  CachePricing,
  ModelPrice,
  OracleCacheBlock,
  OracleCacheComponentWire,
  ScuFamilyRepresentative,
  ScuValue,
} from "./types.js";
import { getFieldMap } from "./field-map.js";

const API_BASE = process.env.CF_API_BASE ?? "https://api.compute.finance";

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
let cpiCache: CacheEntry<unknown> | null = null;
let scuCache: CacheEntry<unknown> | null = null;
let reconstitutionsCache: CacheEntry<unknown> | null = null;
let methodologyCache: CacheEntry<unknown> | null = null;
let basketCache: CacheEntry<ModelPrice[]> | null = null;
const familyDriftWarned = new Set<string>();
// WeakMap, not Map: the canonical-id Set is GC'd with its basket array — no leak across refreshes.
const idsByBasket = new WeakMap<ModelPrice[], Set<string>>();

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Oracle ${path} returned ${res.status}`);
  }
  return res.json();
}

export async function getCpi(): Promise<unknown> {
  if (cpiCache && Date.now() - cpiCache.fetchedAt < CACHE_TTL_MS) {
    return cpiCache.data;
  }
  const data = await fetchJson("/v1/oracle/basket");
  cpiCache = { data, fetchedAt: Date.now() };
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

export async function getBreakdown(): Promise<unknown> {
  const scu = (await getScu()) as Record<string, unknown> | null;
  return scu && typeof scu === "object" ? scu.breakdown ?? null : null;
}

function parseFamilyRepresentatives(breakdown: unknown): ScuFamilyRepresentative[] {
  if (!breakdown || typeof breakdown !== "object") return [];
  const reps = (breakdown as Record<string, unknown>).familyRepresentatives;
  if (!Array.isArray(reps)) return [];
  const out: ScuFamilyRepresentative[] = [];
  for (const r of reps) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (
      typeof o.family === "string" &&
      typeof o.modelKey === "string" &&
      typeof o.inputPriceUsdPerMillion === "number" &&
      typeof o.outputPriceUsdPerMillion === "number" &&
      typeof o.blendedCostUsd === "number"
    ) {
      out.push({
        family: o.family,
        modelKey: o.modelKey,
        inputPriceUsdPerMillion: o.inputPriceUsdPerMillion,
        outputPriceUsdPerMillion: o.outputPriceUsdPerMillion,
        blendedCostUsd: o.blendedCostUsd,
      });
    }
  }
  return out;
}

// Typed /v1/oracle/scu for renderers (reuses getScu's cache); null when scuUsd is unusable.
export async function getScuValue(): Promise<ScuValue | null> {
  const scu = (await getScu()) as Record<string, unknown> | null;
  if (!scu || typeof scu !== "object") return null;
  const scuUsd = scu.scuUsd;
  if (typeof scuUsd !== "number" || !isFinite(scuUsd) || scuUsd <= 0) return null;
  return {
    scuUsd,
    computeIndex: typeof scu.computeIndex === "number" ? scu.computeIndex : null,
    methodologyVersion:
      typeof scu.methodologyVersion === "number" ? scu.methodologyVersion : 0,
    updatedAt: typeof scu.updatedAt === "string" ? scu.updatedAt : "",
    familyRepresentatives: parseFamilyRepresentatives(scu.breakdown),
  };
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

export async function getMethodology(): Promise<unknown> {
  if (methodologyCache && Date.now() - methodologyCache.fetchedAt < CACHE_TTL_MS) {
    return methodologyCache.data;
  }
  const data = await fetchJson("/v1/oracle/methodology");
  methodologyCache = { data, fetchedAt: Date.now() };
  return data;
}

export type HistoryGranularity = "per-revision" | "daily" | "weekly";

export interface HistoryQuery {
  from?: string;
  to?: string;
  granularity?: HistoryGranularity;
  limit?: number;
}

export function buildHistoryQueryString(query: HistoryQuery): string {
  const params = new URLSearchParams();
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.granularity) params.set("granularity", query.granularity);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function getHistory(query: HistoryQuery = {}): Promise<unknown> {
  return fetchJson(`/v1/oracle/history${buildHistoryQueryString(query)}`);
}

export async function getModelPriceHistory(
  model: string,
  query: HistoryQuery = {},
): Promise<unknown> {
  return fetchJson(
    `/v1/oracle/models/${encodeURIComponent(model)}/price-history${buildHistoryQueryString(query)}`,
  );
}

let catalogCache: CacheEntry<unknown> | null = null;

export async function getCatalog(): Promise<unknown> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CACHE_TTL_MS) {
    return catalogCache.data;
  }
  const data = await fetchJson("/v1/oracle/catalog");
  catalogCache = { data, fetchedAt: Date.now() };
  return data;
}

export async function getModelPriceAt(
  model: string,
  date: string,
): Promise<unknown> {
  const params = new URLSearchParams({ date });
  return fetchJson(
    `/v1/oracle/models/${encodeURIComponent(model)}/price-at?${params.toString()}`,
  );
}

export async function getScuAt(date: string): Promise<unknown> {
  const params = new URLSearchParams({ date });
  const res = await fetch(`${API_BASE}/v1/oracle/scu-at?${params.toString()}`);
  if (res.status === 204) return null;
  if (!res.ok) {
    throw new Error(`Oracle /v1/oracle/scu-at returned ${res.status}`);
  }
  return res.json();
}

let baselineCache: CacheEntry<unknown> | null = null;

export async function getBaseline(): Promise<unknown> {
  if (baselineCache && Date.now() - baselineCache.fetchedAt < CACHE_TTL_MS) {
    return baselineCache.data;
  }
  const res = await fetch(`${API_BASE}/v1/oracle/baseline`);
  if (res.status === 204) {
    baselineCache = { data: null, fetchedAt: Date.now() };
    return null;
  }
  if (!res.ok) {
    throw new Error(`Oracle /v1/oracle/baseline returned ${res.status}`);
  }
  const data = await res.json();
  baselineCache = { data, fetchedAt: Date.now() };
  return data;
}

export async function getActiveMethodologyVersion(): Promise<number | null> {
  try {
    const data = (await getMethodology()) as Record<string, unknown>;
    return typeof data.activeVersion === "number" ? data.activeVersion : null;
  } catch {
    return null;
  }
}

type AnyModel = Record<string, unknown>;

function cpiModels(cpi: unknown, arrayField: string): AnyModel[] {
  const c = cpi as Record<string, unknown>;
  return (c[arrayField] ?? []) as AnyModel[];
}

function inputOutput(obj: unknown): { input: number; output: number } {
  if (!obj || typeof obj !== "object") return { input: 0, output: 0 };
  const o = obj as Record<string, number>;
  return { input: o.input ?? 0, output: o.output ?? 0 };
}

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

function adaptComponent(
  model: string,
  kind: CacheComponentKind,
  inputUsdPerMillion: number,
  raw: OracleCacheComponentWire | null | undefined,
): CachePriceComponent | null {
  if (raw === null || raw === undefined) return null;
  let { usdPerMillion, ratioOfInput } = raw;
  if (usdPerMillion === null && ratioOfInput !== null) {
    usdPerMillion = ratioOfInput * inputUsdPerMillion;
  } else if (ratioOfInput === null && usdPerMillion !== null && inputUsdPerMillion > 0) {
    ratioOfInput = usdPerMillion / inputUsdPerMillion;
  }
  if (usdPerMillion === null || ratioOfInput === null) {
    throw new Error(
      `Oracle cache component ${model}.${kind} is unusable: ` +
        "both usdPerMillion and ratioOfInput are null (or ratioOfInput requires inputUsdPerMillion > 0 to derive). " +
        "This points to a corrupted oracle row — investigate the producer.",
    );
  }
  return {
    usdPerMillion,
    ratioOfInput,
    source: raw.source,
    sourceUrl: raw.sourceUrl,
    createdAt: raw.createdAt,
  };
}

function adaptCache(
  model: string,
  inputUsdPerMillion: number,
  block: OracleCacheBlock | null | undefined,
): CachePricing | null {
  if (block === null || block === undefined) return null;
  return {
    cachedInput: adaptComponent(model, "cachedInput", inputUsdPerMillion, block.cachedInput),
    cacheWrite5m: adaptComponent(model, "cacheWrite5m", inputUsdPerMillion, block.cacheWrite5m),
    cacheWrite1h: adaptComponent(model, "cacheWrite1h", inputUsdPerMillion, block.cacheWrite1h),
  };
}

export async function getBasketPrices(): Promise<ModelPrice[]> {
  if (basketCache && Date.now() - basketCache.fetchedAt < CACHE_TTL_MS) {
    return basketCache.data;
  }
  const fm = getFieldMap().basket;
  const cpi = await getCpi();
  const out: ModelPrice[] = [];
  for (const m of cpiModels(cpi, fm.models_array)) {
    const id = m[fm.model_id] as string;
    if (!id) continue;
    const providerObj = m[fm.provider] as Record<string, unknown> | undefined;
    const providerKey = (providerObj?.[fm.provider_key] as string) ?? "unknown";
    const providerName = (providerObj?.[fm.provider_name] as string) ?? providerKey;
    const markedUpUsd = inputOutput(m[fm.marked_up_usd_price]);
    const markedUpWei = inputOutput(m[fm.marked_up_wei_price]);
    const rawCache = (m.cache ?? null) as OracleCacheBlock | null;
    const family = m[fm.family] as string | undefined;
    if (!family && !familyDriftWarned.has(id)) {
      familyDriftWarned.add(id);
      process.stderr.write(
        `[oracle] basket model ${id} missing required family field — upstream schema drift\n`,
      );
    }
    out.push({
      model: id,
      display_name: (m[fm.display_name] as string) ?? id,
      provider: providerKey,
      provider_name: providerName,
      family: family ?? "",
      integrated: (m[fm.integrated] as boolean) ?? false,
      released_at: (m[fm.released_at] as string | null) ?? null,
      input_usd_per_million: markedUpUsd.input,
      output_usd_per_million: markedUpUsd.output,
      input_wei_per_million: markedUpWei.input,
      output_wei_per_million: markedUpWei.output,
      cache: adaptCache(id, markedUpUsd.input, rawCache),
    });
  }
  basketCache = { data: out, fetchedAt: Date.now() };
  return out;
}

export async function getModelPrice(model: string): Promise<ModelPrice | null> {
  const all = await getBasketPrices();
  return all.find((m) => m.model === model) ?? null;
}

function canonicalizeIn(raw: string, ids: Set<string>): string | null {
  if (ids.has(raw)) return raw;
  const stripped = raw.replace(/\[[^\]]+\]/g, "").replace(/-\d{8,}$/, "");
  if (ids.has(stripped)) return stripped;
  let dotNormalized = stripped;
  for (let i = 1; i < stripped.length - 1; i++) {
    if (
      stripped[i] === "-" &&
      /\d/.test(stripped[i - 1]) &&
      /\d/.test(stripped[i + 1])
    ) {
      const candidate = stripped.slice(0, i) + "." + stripped.slice(i + 1);
      if (ids.has(candidate)) return candidate;
      dotNormalized = candidate;
    }
  }
  const familyMatch = dotNormalized.match(/^(.+?)-(\d+(?:\.\d+)?)$/);
  if (familyMatch) {
    const family = familyMatch[1];
    const version = parseFloat(familyMatch[2]);
    let best: string | null = null;
    let bestDist = Infinity;
    for (const id of ids) {
      const m = id.match(/^(.+?)-(\d+(?:\.\d+)?)$/);
      if (m && m[1] === family) {
        const dist = Math.abs(parseFloat(m[2]) - version);
        if (dist < bestDist) { bestDist = dist; best = id; }
      }
    }
    if (best) return best;
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

export function nominalCost(
  price: ModelPrice,
  rawIn: number,
  cacheRead: number,
  cacheCreate: number,
  out: number,
): number {
  const inPerTok = price.input_usd_per_million / 1_000_000;
  const outPerTok = price.output_usd_per_million / 1_000_000;
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
  const inPerTok = price.input_usd_per_million / 1_000_000;
  const outPerTok = price.output_usd_per_million / 1_000_000;

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

export const _internals = {
  adaptComponent,
  adaptCache,
  buildAttributionNotes,
  parseFamilyRepresentatives,
};

import {
  BasePriceProvenance,
  CachePricing,
  ModelPrice,
  OracleCacheBlock,
  OraclePriceComponentWire,
  OracleReasoningBlock,
  PriceComponent,
  PriceComponentKind,
  PriceSource,
  ReasoningPricing,
  ResolvedModel,
  ScuFamilyRepresentative,
  ScuValue,
} from "./types.js";
import { getFieldMap } from "./field-map.js";
import { trimFloatNoise } from "../render/format.js";

export const API_BASE = process.env.CF_API_BASE ?? "https://api.compute.finance";

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
let cpiCache: CacheEntry<unknown> | null = null;
let cpiInflight: Promise<unknown> | null = null;
let scuCache: CacheEntry<unknown> | null = null;
let reconstitutionsCache: CacheEntry<unknown> | null = null;
let methodologyCache: CacheEntry<unknown> | null = null;
let basketCache: CacheEntry<ModelPrice[]> | null = null;
const driftWarned = new Set<string>();

export function warnDriftOnce(key: string, message: string): void {
  if (driftWarned.has(key)) return;
  driftWarned.add(key);
  process.stderr.write(`[oracle] ${message}\n`);
}

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
  if (cpiInflight) return cpiInflight;
  cpiInflight = fetchJson("/v1/oracle/basket")
    .then((data) => {
      cpiCache = { data, fetchedAt: Date.now() };
      return data;
    })
    .finally(() => {
      cpiInflight = null;
    });
  return cpiInflight;
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

function adaptComponent(
  model: string,
  kind: PriceComponentKind,
  inputUsdPerMillion: number,
  raw: OraclePriceComponentWire | null | undefined,
): PriceComponent | null {
  if (raw === null || raw === undefined) return null;
  let { usdPerMillion, ratioOfInput } = raw;
  if (usdPerMillion === null && ratioOfInput !== null) {
    usdPerMillion = trimFloatNoise(ratioOfInput * inputUsdPerMillion);
  } else if (ratioOfInput === null && usdPerMillion !== null && inputUsdPerMillion > 0) {
    ratioOfInput = trimFloatNoise(usdPerMillion / inputUsdPerMillion);
  }
  if (usdPerMillion === null || ratioOfInput === null) {
    throw new Error(
      `Oracle price component ${model}.${kind} is unusable: ` +
        "both usdPerMillion and ratioOfInput are null (or ratioOfInput requires inputUsdPerMillion > 0 to derive). " +
        "This points to a corrupted oracle row — investigate the producer.",
    );
  }
  return {
    usdPerMillion,
    ratioOfInput,
    provenance: raw.provenance,
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

// Nothing bills on reasoning, so a corrupt row degrades instead of failing the response.
function adaptReasoning(
  model: string,
  inputUsdPerMillion: number,
  block: OracleReasoningBlock | null | undefined,
): ReasoningPricing | null {
  if (block === null || block === undefined) return null;
  try {
    return {
      reasoningOutput: adaptComponent(
        model,
        "reasoningOutput",
        inputUsdPerMillion,
        block.reasoningOutput,
      ),
    };
  } catch (err) {
    warnDriftOnce(
      `reasoning:${model}`,
      `${(err as Error).message} Reporting no reasoning price for ${model}.`,
    );
    return null;
  }
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
    const baseUsd = inputOutput(m[fm.base_usd_price]);
    const baseWei = inputOutput(m[fm.base_wei_price]);
    const rawCache = (m.cache ?? null) as OracleCacheBlock | null;
    const rawReasoning = (m.reasoning ?? null) as OracleReasoningBlock | null;
    const family = m[fm.family] as string | undefined;
    if (!family) {
      warnDriftOnce(
        `family:${id}`,
        `basket model ${id} missing required family field — upstream schema drift`,
      );
    }
    out.push({
      model: id,
      display_name: (m[fm.display_name] as string) ?? id,
      provider: providerKey,
      provider_name: providerName,
      family: family ?? "",
      released_at: (m[fm.released_at] as string | null) ?? null,
      base_input_usd_per_million: baseUsd.input,
      base_output_usd_per_million: baseUsd.output,
      base_input_wei_per_million: baseWei.input,
      base_output_wei_per_million: baseWei.output,
      cache: adaptCache(id, baseUsd.input, rawCache),
      reasoning: adaptReasoning(id, baseUsd.input, rawReasoning),
    });
  }
  basketCache = { data: out, fetchedAt: Date.now() };
  return out;
}

export async function getModelPrice(model: string): Promise<ModelPrice | null> {
  const all = await getBasketPrices();
  return all.find((m) => m.model === model) ?? null;
}

interface WireResolveResponse {
  inputKey: string;
  resolvedKey: string;
  family: string | null;
  provider: { key: string; name: string } | null;
  prices: {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
    provenance: BasePriceProvenance;
  } | null;
  cache: OracleCacheBlock | null;
  reasoning: OracleReasoningBlock | null;
  inBasket: boolean;
  priceSource: PriceSource;
}

const resolveCache = new Map<string, CacheEntry<ResolvedModel>>();

function adaptResolved(wire: WireResolveResponse): ResolvedModel {
  const inputUsd = wire.prices?.inputUsdPerMillion ?? 0;
  return {
    input_key: wire.inputKey,
    resolved_key: wire.resolvedKey,
    family: wire.family,
    provider: wire.provider,
    base_input_usd_per_million: wire.prices?.inputUsdPerMillion ?? null,
    base_output_usd_per_million: wire.prices?.outputUsdPerMillion ?? null,
    base_price_provenance: wire.prices?.provenance ?? null,
    cache: adaptCache(wire.resolvedKey, inputUsd, wire.cache),
    reasoning: adaptReasoning(wire.resolvedKey, inputUsd, wire.reasoning),
    in_basket: wire.inBasket,
    price_source: wire.priceSource,
  };
}

export async function resolveModel(
  name: string | null | undefined,
): Promise<ResolvedModel | null> {
  if (!name) return null;
  const cached = resolveCache.get(name);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const wire = (await fetchJson(
      `/v1/oracle/resolve/${encodeURIComponent(name)}`,
    )) as WireResolveResponse;
    const adapted = adaptResolved(wire);
    resolveCache.set(name, { data: adapted, fetchedAt: Date.now() });
    return adapted;
  } catch {
    return null;
  }
}

export function _resetResolveCache(): void {
  resolveCache.clear();
}

export function _resetBasketCache(): void {
  basketCache = null;
  cpiCache = null;
  cpiInflight = null;
}

export function _resetCatalogCache(): void {
  catalogCache = null;
}

export function _seedBasketCache(models: ModelPrice[]): void {
  basketCache = { data: models, fetchedAt: Date.now() };
}

export interface ResolvedModelPrice {
  price: ModelPrice;
  source: Exclude<PriceSource, "off-basket">;
  base_price_provenance: BasePriceProvenance | null;
}

export async function resolveModelPrice(
  model: string,
): Promise<ResolvedModelPrice | null> {
  const resolved = await resolveModel(model);
  if (!resolved || resolved.price_source === "off-basket") return null;
  const source = resolved.price_source;
  if (resolved.in_basket) {
    const manifestEntry = await getModelPrice(resolved.resolved_key);
    if (manifestEntry) {
      return { price: manifestEntry, source, base_price_provenance: null };
    }
  }
  return {
    price: resolvedToModelPrice(resolved),
    source,
    base_price_provenance: resolved.base_price_provenance,
  };
}

export function resolvedToModelPrice(r: ResolvedModel): ModelPrice {
  return {
    model: r.resolved_key,
    display_name: r.resolved_key,
    provider: r.provider?.key ?? "",
    provider_name: r.provider?.name ?? "",
    family: r.family ?? "",
    released_at: null,
    base_input_usd_per_million: r.base_input_usd_per_million ?? 0,
    base_output_usd_per_million: r.base_output_usd_per_million ?? 0,
    base_input_wei_per_million: null,
    base_output_wei_per_million: null,
    cache: r.cache,
    reasoning: r.reasoning,
  };
}

export const _internals = {
  adaptComponent,
  adaptCache,
  adaptReasoning,
  parseFamilyRepresentatives,
};

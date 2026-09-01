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
import { trimFloatNoise } from "../render/format.js";

export const API_BASE = process.env.CF_API_BASE ?? "https://api.compute.finance";

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000;
const jsonCache = new Map<string, CacheEntry<unknown>>();
const jsonInflight = new Map<string, Promise<unknown>>();
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

function cachedJson(path: string): Promise<unknown> {
  const cached = jsonCache.get(path);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return Promise.resolve(cached.data);
  }
  const inflight = jsonInflight.get(path);
  if (inflight) return inflight;
  const request = fetchJson(path)
    .then((data) => {
      jsonCache.set(path, { data, fetchedAt: Date.now() });
      return data;
    })
    .finally(() => {
      jsonInflight.delete(path);
    });
  jsonInflight.set(path, request);
  return request;
}

export async function getCpi(): Promise<unknown> {
  return cachedJson("/v1/oracle/basket");
}

export async function getScu(): Promise<unknown> {
  return cachedJson("/v1/oracle/scu");
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
  return cachedJson("/v1/oracle/reconstitutions");
}

export async function getMethodology(): Promise<unknown> {
  return cachedJson("/v1/oracle/methodology");
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

export async function getCatalog(): Promise<unknown> {
  return cachedJson("/v1/oracle/catalog");
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

interface WireCatalogModel {
  modelKey: string;
  displayName?: string | null;
  provider?: { key?: string; name?: string } | null;
  family?: string | null;
  indexMember?: boolean;
  releasedAt?: string | null;
  currentPrice?: {
    inputPriceUsdPerMillion: number;
    outputPriceUsdPerMillion: number;
    provenance?: BasePriceProvenance | null;
  } | null;
  cache?: OracleCacheBlock | null;
  reasoning?: OracleReasoningBlock | null;
}

function adaptCatalogModel(m: WireCatalogModel): ModelPrice | null {
  const price = m.currentPrice;
  if (typeof m.modelKey !== "string" || !m.modelKey || !price) return null;
  if (!m.family) {
    warnDriftOnce(
      `family:${m.modelKey}`,
      `catalog model ${m.modelKey} missing required family field — upstream schema drift`,
    );
  }
  const input = price.inputPriceUsdPerMillion;
  return {
    model: m.modelKey,
    display_name: m.displayName ?? m.modelKey,
    provider: m.provider?.key ?? "",
    provider_name: m.provider?.name ?? "",
    family: m.family ?? "",
    released_at: m.releasedAt ?? null,
    base_input_usd_per_million: input,
    base_output_usd_per_million: price.outputPriceUsdPerMillion,
    base_price_provenance: price.provenance ?? null,
    cache: adaptCache(m.modelKey, input, m.cache),
    reasoning: adaptReasoning(m.modelKey, input, m.reasoning),
  };
}

async function catalogModels(): Promise<WireCatalogModel[]> {
  const catalog = (await getCatalog()) as { models?: unknown } | null;
  return Array.isArray(catalog?.models) ? (catalog.models as WireCatalogModel[]) : [];
}

function adaptCatalogModels(models: WireCatalogModel[]): ModelPrice[] {
  const out: ModelPrice[] = [];
  for (const m of models) {
    const price = adaptCatalogModel(m);
    if (price) out.push(price);
  }
  return out;
}

export async function getCatalogPrices(): Promise<ModelPrice[]> {
  return adaptCatalogModels(await catalogModels());
}

export async function getIndexPrices(): Promise<ModelPrice[]> {
  return adaptCatalogModels(
    (await catalogModels()).filter((m) => m.indexMember === true),
  );
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

export function _resetOracleCache(): void {
  jsonCache.clear();
  jsonInflight.clear();
}

export interface ResolvedModelPrice {
  price: ModelPrice;
  source: Exclude<PriceSource, "off-basket">;
}

export async function resolveModelPrice(
  model: string,
): Promise<ResolvedModelPrice | null> {
  const resolved = await resolveModel(model);
  if (!resolved || resolved.price_source === "off-basket") return null;
  return {
    price: await namedModelPrice(resolved),
    source: resolved.price_source,
  };
}

export async function namedModelPrice(r: ResolvedModel): Promise<ModelPrice> {
  const price = resolvedToModelPrice(r);
  const listed = await catalogListing(price.model);
  return listed
    ? {
        ...price,
        display_name: listed.displayName ?? price.display_name,
        released_at: listed.releasedAt ?? null,
      }
    : price;
}

async function catalogListing(modelKey: string): Promise<WireCatalogModel | null> {
  try {
    return (await catalogModels()).find((m) => m.modelKey === modelKey) ?? null;
  } catch (err) {
    warnDriftOnce(
      "catalog-listing",
      `${(err as Error).message} Serving prices without catalogue display names.`,
    );
    return null;
  }
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
    base_price_provenance: r.base_price_provenance,
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

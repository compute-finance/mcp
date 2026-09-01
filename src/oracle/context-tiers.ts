import { getCatalog, warnDriftOnce } from "./client.js";
import { billed, usdCost, type UsdCost } from "./pricing-wire.js";
import {
  PROVENANCE_MARKS,
  type ContextLadder,
  type ContextTier,
  type ContextTierRates,
  type MarkedBaseRates,
  type ModelContext,
  type OracleContextTierWire,
  type PriceProvenance,
} from "./types.js";

export const CONTEXT_UNAVAILABLE = {
  context_tiers: null,
  max_input_tokens: null,
} as const;

export interface CatalogContext {
  tiers: OracleContextTierWire[];
  maxInputTokens: number | null;
}

function positiveInteger(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
}

function parseTier(raw: unknown): OracleContextTierWire | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // the flat rate already occupies rung 0, so an upstream rung must sit strictly above it
  const fromInputTokens = positiveInteger(o.fromInputTokens);
  if (
    fromInputTokens === null ||
    typeof o.inputPriceUsdPerMillion !== "number" ||
    typeof o.outputPriceUsdPerMillion !== "number" ||
    !PROVENANCE_MARKS.includes(o.provenance as PriceProvenance)
  ) {
    return null;
  }
  return {
    fromInputTokens,
    inputPriceUsdPerMillion: o.inputPriceUsdPerMillion,
    outputPriceUsdPerMillion: o.outputPriceUsdPerMillion,
    provenance: o.provenance as PriceProvenance,
  };
}

function parseTiers(modelKey: string, raw: unknown): OracleContextTierWire[] {
  if (!Array.isArray(raw)) return [];
  const parsed = raw.map(parseTier);
  const usable = parsed.filter((t): t is OracleContextTierWire => t !== null);
  if (usable.length < parsed.length) {
    warnDriftOnce(
      `contextTiers:${modelKey}`,
      `catalog model ${modelKey} published an unusable context tier — it is dropped from the ladder and long-context estimates will read low`,
    );
  }
  const ascending = usable
    .sort((a, b) => a.fromInputTokens - b.fromInputTokens)
    .filter((t, i, sorted) => i === 0 || t.fromInputTokens > sorted[i - 1].fromInputTokens);
  if (ascending.length < usable.length) {
    warnDriftOnce(
      `contextTierThresholds:${modelKey}`,
      `catalog model ${modelKey} published more than one context tier at the same threshold — only the first is kept, so a long-context estimate may not match the bill`,
    );
  }
  return ascending;
}

export async function getCatalogContexts(): Promise<Map<string, CatalogContext>> {
  const catalog = (await getCatalog()) as Record<string, unknown> | null;
  const models = Array.isArray(catalog?.models) ? (catalog.models as unknown[]) : [];
  const out = new Map<string, CatalogContext>();
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.modelKey !== "string") continue;
    out.set(m.modelKey, {
      tiers: parseTiers(m.modelKey, m.contextTiers),
      maxInputTokens: positiveInteger(m.maxInputTokens),
    });
  }
  return out;
}

export async function tryCatalogContexts(): Promise<Map<string, CatalogContext> | null> {
  try {
    return await getCatalogContexts();
  } catch {
    return null;
  }
}

export function contextFor(
  contexts: Map<string, CatalogContext> | null,
  modelKey: string,
): CatalogContext | null {
  const found = contexts?.get(modelKey) ?? null;
  if (contexts && !found) {
    warnDriftOnce(
      `contextMissing:${modelKey}`,
      `catalog does not list ${modelKey} — its context ladder reads unknown rather than flat`,
    );
  }
  return found;
}

export function requireContextFor(
  contexts: Map<string, CatalogContext>,
  modelKey: string,
): CatalogContext {
  const found = contexts.get(modelKey);
  if (!found) {
    throw new Error(
      `Catalog does not list ${modelKey}, so its long-context price ladder is unknown — quoting at the flat rate would understate a long context.`,
    );
  }
  return found;
}

function withBilledTier(rung: ContextTierRates, rate: number | null): ContextTier {
  return {
    ...rung,
    billed_input_usd_per_million: billed(rung.base_input_usd_per_million, rate),
    billed_output_usd_per_million: billed(rung.base_output_usd_per_million, rate),
  };
}

function contextLadder(
  rates: MarkedBaseRates,
  catalog: CatalogContext,
  routingFeeRate: number | null,
): ContextLadder {
  const flat: ContextTierRates = {
    from_input_tokens: 0,
    base_input_usd_per_million: rates.base_input_usd_per_million,
    base_output_usd_per_million: rates.base_output_usd_per_million,
    provenance: rates.base_price_provenance,
  };
  const rungs = catalog.tiers.map((t) => ({
    from_input_tokens: t.fromInputTokens,
    base_input_usd_per_million: t.inputPriceUsdPerMillion,
    base_output_usd_per_million: t.outputPriceUsdPerMillion,
    provenance: { input: t.provenance, output: t.provenance },
  }));
  return [
    withBilledTier(flat, routingFeeRate),
    ...rungs.map((r) => withBilledTier(r, routingFeeRate)),
  ];
}

export function modelContext(
  rates: MarkedBaseRates,
  catalog: CatalogContext,
  routingFeeRate: number | null,
): ModelContext {
  return {
    context_tiers: contextLadder(rates, catalog, routingFeeRate),
    max_input_tokens: catalog.maxInputTokens,
  };
}

export function selectContextTier(
  tiers: ContextLadder,
  inputTokens: number,
): ContextTier {
  let applied = tiers[0];
  for (const t of tiers) {
    if (inputTokens >= t.from_input_tokens) applied = t;
  }
  return applied;
}

export interface ContextTierQuote extends UsdCost {
  applied_context_tier: ContextTier;
  max_input_tokens: number | null;
  exceeds_max_input_tokens: boolean;
}

export function quoteAtContextTier(
  rates: MarkedBaseRates,
  catalog: CatalogContext,
  routingFeeRate: number | null,
  inputTokens: number,
  outputTokens: number,
): ContextTierQuote {
  const ladder = contextLadder(rates, catalog, routingFeeRate);
  const applied = selectContextTier(ladder, inputTokens);
  const max_input_tokens = catalog.maxInputTokens;
  return {
    ...usdCost(applied, inputTokens, outputTokens, routingFeeRate),
    applied_context_tier: applied,
    max_input_tokens,
    exceeds_max_input_tokens:
      max_input_tokens !== null && inputTokens > max_input_tokens,
  };
}

/**
 * Boot-time field mapping derived from the Oracle's OpenAPI response schema.
 *
 * Instead of hardcoding Oracle API field names, this module derives a mapping
 * at startup by parsing the OpenAPI response schema for /v1/oracle/basket.
 * When the Oracle renames a field (e.g. ct → wei), the semantic matcher
 * auto-discovers the new name — zero runtime token cost, no AI involved.
 * Discovery requires at least one keyword from each field's `required` list
 * to appear in the new name; renames that drop all keywords (e.g.
 * displayName → label) fall back to defaults and appear in `unmapped`.
 *
 * Fallback chain: OpenAPI → disk (last-known-good) → hardcoded defaults.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAllOracleToolResponseSchemas } from "./openapi-schema.js";

// ── Types ───────────────────────────────────────────────────────────

export interface BasketFieldMap {
  models_array: string;
  model_id: string;
  display_name: string;
  provider: string;
  provider_key: string;
  provider_name: string;
  family: string;
  integrated: string;
  released_at: string;
  marked_up_usd_price: string;
  marked_up_wei_price: string;
}

export interface ReconFieldMap {
  entries_array: string;
  sort_date: string;
}

export interface FieldMap {
  basket: BasketFieldMap;
  recon: ReconFieldMap;
  source: "openapi" | "disk-fallback" | "hardcoded";
  derived_at: string;
  mismatches: string[];
  unmapped: string[];
}

// ── Defaults (current known field names) ────────────────────────────

export const DEFAULT_BASKET: BasketFieldMap = {
  models_array: "models",
  model_id: "id",
  display_name: "displayName",
  provider: "provider",
  provider_key: "key",
  provider_name: "name",
  family: "family",
  integrated: "integrated",
  released_at: "releasedAt",
  marked_up_usd_price: "markedUpUsdPricePerMillion",
  marked_up_wei_price: "markedUpWeiPricePerMillion",
};

const DEFAULT_RECON: ReconFieldMap = {
  entries_array: "entries",
  sort_date: "publishedAt",
};

// ── Persistence ─────────────────────────────────────────────────────

const PERSIST_DIR = join(homedir(), ".compute-finance");
const PERSIST_PATH = join(PERSIST_DIR, "field-map.json");

function persistToDisk(map: FieldMap): void {
  try {
    if (!existsSync(PERSIST_DIR)) mkdirSync(PERSIST_DIR, { recursive: true });
    writeFileSync(PERSIST_PATH, JSON.stringify(map, null, 2));
  } catch { /* non-critical */ }
}

function hasAllStringKeys<T extends object>(obj: unknown, reference: T): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  return Object.keys(reference).every((k) => typeof rec[k] === "string");
}

function loadFromDisk(): FieldMap | null {
  try {
    if (!existsSync(PERSIST_PATH)) return null;
    const raw = JSON.parse(readFileSync(PERSIST_PATH, "utf-8"));
    if (
      hasAllStringKeys(raw?.basket, DEFAULT_BASKET) &&
      hasAllStringKeys(raw?.recon, DEFAULT_RECON)
    ) {
      return { ...raw, source: "disk-fallback" } as FieldMap;
    }
  } catch { /* corrupt file — ignore */ }
  return null;
}

// ── Schema helpers ──────────────────────────────────────────────────

type SchemaObj = Record<string, unknown>;
type Properties = Record<string, SchemaObj>;

function getProperties(schema: SchemaObj): Properties {
  return (schema.properties ?? {}) as Properties;
}

function getItemSchema(schema: SchemaObj): SchemaObj | null {
  if (schema.type === "array" && schema.items && typeof schema.items === "object") {
    return schema.items as SchemaObj;
  }
  return null;
}

function fieldType(prop: SchemaObj): string {
  return (prop.type as string) ?? "unknown";
}

function hasInputOutput(prop: SchemaObj): boolean {
  const sub = getProperties(prop);
  return "input" in sub && "output" in sub;
}

// ── Semantic field matcher ──────────────────────────────────────────

interface MatchRule {
  required: string[];
  preferred?: string[];
  exclude?: string[];
  type?: string;
  inputOutput?: boolean;
}

function findField(
  props: Properties,
  defaultName: string,
  rule: MatchRule,
): { name: string; exact: boolean } | null {
  if (defaultName in props) return { name: defaultName, exact: true };

  const candidates: Array<{ name: string; score: number }> = [];
  for (const [name, schema] of Object.entries(props)) {
    const low = name.toLowerCase();
    if (rule.type && fieldType(schema) !== rule.type) continue;
    if (rule.inputOutput && !hasInputOutput(schema)) continue;
    if (rule.exclude?.some((kw) => low.includes(kw))) continue;
    if (!rule.required.every((kw) => low.includes(kw))) continue;

    let score = 10;
    if (rule.preferred) {
      for (const kw of rule.preferred) {
        if (low.includes(kw)) score += 3;
      }
    }
    score -= name.length * 0.01;
    candidates.push({ name, score });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return { name: candidates[0].name, exact: false };
}

// ── Basket field derivation ─────────────────────────────────────────

const BASKET_MATCHERS: Record<
  Exclude<keyof BasketFieldMap, "models_array" | "provider_key" | "provider_name">,
  MatchRule
> = {
  model_id: { required: ["id"], type: "string", exclude: ["oracle", "prefix", "key"] },
  display_name: { required: ["name"], preferred: ["display"], type: "string", exclude: ["provider"] },
  provider: { required: ["provider"], type: "object" },
  family: { required: ["family"], exclude: ["count", "id"], type: "string" },
  integrated: { required: ["integrat"], type: "boolean" },
  released_at: { required: ["releas"], type: "string" },
  marked_up_usd_price: {
    required: ["usd"],
    preferred: ["marked", "markup"],
    type: "object",
    inputOutput: true,
  },
  marked_up_wei_price: {
    required: ["price"],
    preferred: ["marked", "markup", "wei", "compute", "ct"],
    exclude: ["usd"],
    type: "object",
    inputOutput: true,
  },
};

function deriveBasketMap(responseSchema: SchemaObj): {
  map: BasketFieldMap;
  mismatches: string[];
  unmapped: string[];
} {
  const topProps = getProperties(responseSchema);
  const mismatches: string[] = [];
  const unmapped: string[] = [];

  // 1. Find models array
  let models_array = DEFAULT_BASKET.models_array;
  if (!(models_array in topProps)) {
    const found = Object.entries(topProps).find(([, s]) => {
      const item = getItemSchema(s);
      return item && fieldType(item) === "object";
    });
    if (found) {
      models_array = found[0];
      mismatches.push(`models_array: ${DEFAULT_BASKET.models_array} → ${models_array}`);
    } else {
      unmapped.push("models_array");
    }
  }

  const arraySchema = topProps[models_array];
  if (!arraySchema) {
    return { map: DEFAULT_BASKET, mismatches, unmapped: ["models_array"] };
  }
  const itemSchema = getItemSchema(arraySchema);
  if (!itemSchema) {
    return { map: DEFAULT_BASKET, mismatches, unmapped: ["model_item_schema"] };
  }
  const modelProps = getProperties(itemSchema);

  // 2. Map each model-level field via matchers
  const mapped: Record<string, string> = {};
  for (const [role, rule] of Object.entries(BASKET_MATCHERS)) {
    const defaultName = DEFAULT_BASKET[role as keyof BasketFieldMap];
    const result = findField(modelProps, defaultName, rule);
    if (result) {
      mapped[role] = result.name;
      if (!result.exact) {
        mismatches.push(`${role}: ${defaultName} → ${result.name}`);
      }
    } else {
      mapped[role] = defaultName;
      unmapped.push(role);
    }
  }

  // 3. Ensure wei price ≠ usd price
  if (mapped.marked_up_wei_price === mapped.marked_up_usd_price) {
    for (const [name, schema] of Object.entries(modelProps)) {
      if (name === mapped.marked_up_usd_price) continue;
      if (
        fieldType(schema) === "object" &&
        hasInputOutput(schema) &&
        !name.toLowerCase().includes("usd") &&
        name.toLowerCase().includes("marked")
      ) {
        mapped.marked_up_wei_price = name;
        mismatches.push(
          `marked_up_wei_price: collision resolved → ${name}`,
        );
        break;
      }
    }
  }

  // 4. Provider subfields
  let provider_key = DEFAULT_BASKET.provider_key;
  let provider_name = DEFAULT_BASKET.provider_name;
  const providerSchema = modelProps[mapped.provider];
  if (providerSchema) {
    const providerProps = getProperties(providerSchema);
    if (!(provider_key in providerProps)) {
      const found = Object.entries(providerProps).find(
        ([n, s]) => fieldType(s) === "string" && n.toLowerCase().includes("key"),
      );
      if (found) {
        provider_key = found[0];
        mismatches.push(`provider_key: ${DEFAULT_BASKET.provider_key} → ${provider_key}`);
      } else {
        unmapped.push("provider_key");
      }
    }
    if (!(provider_name in providerProps)) {
      const found = Object.entries(providerProps).find(
        ([n, s]) => fieldType(s) === "string" && n.toLowerCase().includes("name"),
      );
      if (found) {
        provider_name = found[0];
        mismatches.push(`provider_name: ${DEFAULT_BASKET.provider_name} → ${provider_name}`);
      } else {
        unmapped.push("provider_name");
      }
    }
  }

  return {
    map: {
      models_array,
      model_id: mapped.model_id,
      display_name: mapped.display_name,
      provider: mapped.provider,
      provider_key,
      provider_name,
      family: mapped.family,
      integrated: mapped.integrated,
      released_at: mapped.released_at,
      marked_up_usd_price: mapped.marked_up_usd_price,
      marked_up_wei_price: mapped.marked_up_wei_price,
    },
    mismatches,
    unmapped,
  };
}

// ── Reconstitution field derivation ─────────────────────────────────

function deriveReconMap(responseSchema: SchemaObj): {
  map: ReconFieldMap;
  mismatches: string[];
  unmapped: string[];
} {
  const topProps = getProperties(responseSchema);
  const mismatches: string[] = [];
  const unmapped: string[] = [];

  let entries_array = DEFAULT_RECON.entries_array;
  if (!(entries_array in topProps)) {
    const found = Object.entries(topProps).find(([, s]) => fieldType(s) === "array");
    if (found) {
      entries_array = found[0];
      mismatches.push(`entries_array: ${DEFAULT_RECON.entries_array} → ${entries_array}`);
    } else {
      unmapped.push("entries_array");
    }
  }

  let sort_date = DEFAULT_RECON.sort_date;
  const arraySchema = topProps[entries_array];
  if (arraySchema) {
    const itemSchema = getItemSchema(arraySchema);
    if (itemSchema) {
      const entryProps = getProperties(itemSchema);
      if (!(sort_date in entryProps)) {
        const found = Object.entries(entryProps).find(([n, s]) => {
          const low = n.toLowerCase();
          return (
            fieldType(s) === "string" &&
            (low.includes("date") ||
              low.includes("publish") ||
              low.includes("time") ||
              (s.format as string | undefined) === "date-time")
          );
        });
        if (found) {
          sort_date = found[0];
          mismatches.push(`sort_date: ${DEFAULT_RECON.sort_date} → ${sort_date}`);
        } else {
          unmapped.push("sort_date");
        }
      }
    }
  }

  return { map: { entries_array, sort_date }, mismatches, unmapped };
}

// ── Public API ──────────────────────────────────────────────────────

let fieldMap: FieldMap | null = null;

export async function initFieldMap(): Promise<FieldMap> {
  if (fieldMap) return fieldMap;

  try {
    const responseSchemas = await getAllOracleToolResponseSchemas();
    const basketSchema = responseSchemas["data_get_basket"] ?? responseSchemas["data_get_cpi"];
    const reconSchema = responseSchemas["data_get_reconstitutions"];

    const allMismatches: string[] = [];
    const allUnmapped: string[] = [];
    let basket: BasketFieldMap;
    let recon: ReconFieldMap;

    if (basketSchema) {
      const r = deriveBasketMap(basketSchema as SchemaObj);
      basket = r.map;
      allMismatches.push(...r.mismatches);
      allUnmapped.push(...r.unmapped);
    } else {
      basket = DEFAULT_BASKET;
      allUnmapped.push("basket_schema_missing");
    }

    if (reconSchema) {
      const r = deriveReconMap(reconSchema as SchemaObj);
      recon = r.map;
      allMismatches.push(...r.mismatches);
      allUnmapped.push(...r.unmapped);
    } else {
      recon = DEFAULT_RECON;
    }

    fieldMap = {
      basket,
      recon,
      source: basketSchema ? "openapi" : "hardcoded",
      derived_at: new Date().toISOString(),
      mismatches: allMismatches,
      unmapped: allUnmapped,
    };

    persistToDisk(fieldMap);

    if (allMismatches.length > 0) {
      process.stderr.write(
        `[field-map] auto-remapped: ${allMismatches.join(", ")}\n`,
      );
    }
    if (allUnmapped.length > 0) {
      process.stderr.write(
        `[field-map] unmapped (using defaults): ${allUnmapped.join(", ")}\n`,
      );
    }

    return fieldMap;
  } catch {
    const fromDisk = loadFromDisk();
    if (fromDisk) {
      fieldMap = fromDisk;
      process.stderr.write("[field-map] using disk fallback\n");
      return fromDisk;
    }

    fieldMap = {
      basket: DEFAULT_BASKET,
      recon: DEFAULT_RECON,
      source: "hardcoded",
      derived_at: new Date().toISOString(),
      mismatches: [],
      unmapped: [],
    };
    return fieldMap;
  }
}

export function getFieldMap(): FieldMap {
  if (!fieldMap) {
    throw new Error("Field map not initialized — call initFieldMap() at startup");
  }
  return fieldMap;
}

// ── Testing helpers ─────────────────────────────────────────────────

export function _resetFieldMap(): void {
  fieldMap = null;
}

export const _internals = {
  findField,
  deriveBasketMap,
  deriveReconMap,
  DEFAULT_BASKET,
  DEFAULT_RECON,
  BASKET_MATCHERS,
};

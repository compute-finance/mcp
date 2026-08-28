import { getAllOracleToolResponseSchemas } from "./openapi-schema.js";
import { loadFromDisk, persistToDisk } from "./field-map-persistence.js";

// ── Types ───────────────────────────────────────────────────────────

export interface BasketFieldMap {
  routing_fee_rate: string;
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
  routing_fee_rate: "routingFeeRate",
};

const DEFAULT_RECON: ReconFieldMap = {
  entries_array: "entries",
  sort_date: "publishedAt",
};

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

// ── Basket field derivation ─────────────────────────────────────────

function deriveBasketMap(responseSchema: SchemaObj): {
  map: BasketFieldMap;
  mismatches: string[];
  unmapped: string[];
} {
  const topProps = getProperties(responseSchema);
  const mismatches: string[] = [];
  const unmapped: string[] = [];

  let routing_fee_rate = DEFAULT_BASKET.routing_fee_rate;
  if (!(routing_fee_rate in topProps)) {
    const found = Object.entries(topProps).find(([n, s]) => {
      const low = n.toLowerCase();
      return (
        fieldType(s) === "number" &&
        (low.includes("fee") || low.includes("markup") || low.includes("routing"))
      );
    });
    if (found) {
      routing_fee_rate = found[0];
      mismatches.push(
        `routing_fee_rate: ${DEFAULT_BASKET.routing_fee_rate} → ${routing_fee_rate}`,
      );
    } else {
      unmapped.push("routing_fee_rate");
    }
  }

  return { map: { routing_fee_rate }, mismatches, unmapped };
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
    const fromDisk = loadFromDisk(DEFAULT_BASKET, DEFAULT_RECON);
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

export function _seedDefaultFieldMap(): void {
  fieldMap = {
    basket: DEFAULT_BASKET,
    recon: DEFAULT_RECON,
    source: "hardcoded",
    derived_at: new Date().toISOString(),
    mismatches: [],
    unmapped: [],
  };
}

export const _internals = {
  deriveBasketMap,
  deriveReconMap,
  DEFAULT_BASKET,
  DEFAULT_RECON,
};

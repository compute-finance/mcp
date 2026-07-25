import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BasketFieldMap, FieldMap, ReconFieldMap } from "./field-map.js";

const PERSIST_DIR = join(homedir(), ".compute-finance");
const PERSIST_PATH = join(PERSIST_DIR, "field-map.json");

export function persistToDisk(map: FieldMap): void {
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

export function loadFromDisk(
  referenceBasket: BasketFieldMap,
  referenceRecon: ReconFieldMap,
): FieldMap | null {
  try {
    if (!existsSync(PERSIST_PATH)) return null;
    const raw = JSON.parse(readFileSync(PERSIST_PATH, "utf-8"));
    if (
      hasAllStringKeys(raw?.basket, referenceBasket) &&
      hasAllStringKeys(raw?.recon, referenceRecon)
    ) {
      return { ...raw, source: "disk-fallback" } as FieldMap;
    }
  } catch { /* corrupt file — ignore */ }
  return null;
}

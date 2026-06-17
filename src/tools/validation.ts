import { isValidSessionId } from "../storage/tools.js";

export function requireString(
  v: unknown,
  name: string,
): string | { error: string } {
  return typeof v === "string" && v.length > 0
    ? v
    : { error: `${name} must be a non-empty string` };
}

export function requireFiniteNumber(
  v: unknown,
  name: string,
): number | { error: string } {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? v
    : { error: `${name} must be a non-negative finite number` };
}

export function checkOptionalSessionId(
  v: unknown,
): string | undefined | { error: string } {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !isValidSessionId(v)) {
    return { error: "session_id must be UUID-shaped (alphanumeric and hyphens)" };
  }
  return v;
}

export function optionalString(
  v: unknown,
  name: string,
): string | undefined | { error: string } {
  if (v === undefined || v === null) return undefined;
  return typeof v === "string"
    ? v
    : { error: `${name} must be a string if provided` };
}

export function optionalBoolean(
  v: unknown,
  name: string,
): boolean | undefined | { error: string } {
  if (v === undefined || v === null) return undefined;
  return typeof v === "boolean"
    ? v
    : { error: `${name} must be a boolean if provided` };
}

export function optionalPositiveNumber(
  v: unknown,
  name: string,
): number | undefined | { error: string } {
  if (v === undefined || v === null) return undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? v
    : { error: `${name} must be a positive finite number if provided` };
}

const HISTORY_GRANULARITIES = ["per-revision", "daily", "weekly"] as const;
export type HistoryGranularity = (typeof HISTORY_GRANULARITIES)[number];

export function optionalHistoryGranularity(
  v: unknown,
  name: string,
): HistoryGranularity | undefined | { error: string } {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(HISTORY_GRANULARITIES as readonly string[]).includes(v)) {
    return {
      error: `${name} must be one of ${HISTORY_GRANULARITIES.join(", ")} if provided`,
    };
  }
  return v as HistoryGranularity;
}

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SubscriptionResult {
  isSubscription: boolean;
}

export function detectSubscription(path?: string): SubscriptionResult {
  const filePath = path ?? join(homedir(), ".claude.json");
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { isSubscription: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { isSubscription: false };
  }
  if (!parsed || typeof parsed !== "object") return { isSubscription: false };
  const account = (parsed as Record<string, unknown>).oauthAccount;
  if (!account || typeof account !== "object") return { isSubscription: false };
  const fields = account as Record<string, unknown>;
  if (fields.hasAvailableSubscription === true) return { isSubscription: true };
  if (fields.billingType === "subscription") return { isSubscription: true };
  return { isSubscription: false };
}

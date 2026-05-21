import { readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSessionUsage } from "../storage/session.js";
import { encodeCwd } from "../storage/tools.js";
import {
  getBasketPrices,
  effectiveCost,
  resolveCanonicalIn,
} from "../oracle/client.js";
import { ModelPrice } from "../oracle/types.js";
import { money, tokens, pad, round } from "./format.js";

export interface ActiveSessionsArgs {
  cwd?: string;
  limit?: number;
  hours?: number;
}

// Locate session files across projects, optionally filtered to one cwd.
function scanSessions(cwd?: string): { path: string; mtime: number }[] {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  const dirs = cwd ? [encodeCwd(cwd)] : readdirSync(root);
  const out: { path: string; mtime: number }[] = [];
  for (const d of dirs) {
    const full = join(root, d);
    if (!existsSync(full)) continue;
    for (const f of readdirSync(full)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(full, f);
      try {
        out.push({ path: p, mtime: statSync(p).mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  return out;
}

export async function renderActiveSessions(
  args: ActiveSessionsArgs,
): Promise<string> {
  const limit = args.limit ?? 10;
  const hours = args.hours ?? 24;
  const cutoff = Date.now() - hours * 3600_000;

  const files = scanSessions(args.cwd)
    .filter((f) => f.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  if (files.length === 0) {
    return `Compute Finance Oracle — no sessions in the last ${hours}h${args.cwd ? ` for ${args.cwd}` : ""}.`;
  }

  const L: string[] = [];
  L.push("Compute Finance Oracle — Active sessions");
  L.push(
    `Scanning ${args.cwd ? args.cwd : "all projects"} · last ${hours}h · top ${limit} by recency`,
  );
  L.push("");
  L.push(
    `  ${pad("session", 12)} ${pad("model", 20)} ${pad("turns", 5, "r")} ${pad("in-tok", 8, "r")} ${pad("out-tok", 8, "r")} ${pad("effective", 10, "r")} ${pad("nominal", 10, "r")}  last-active`,
  );

  let totalEff = 0;
  let totalNom = 0;

  // Fetch the basket once up front. Inside the loop we do a synchronous
  // `basket.find()` — avoids N awaits for a cache that's already hot after the
  // first call, and degrades cleanly to empty basket if the oracle is down.
  let basket: ModelPrice[];
  try {
    basket = await getBasketPrices();
  } catch {
    basket = [];
  }

  for (const f of files) {
    let usage;
    try {
      usage = parseSessionUsage(f.path);
    } catch {
      continue;
    }
    const normalized = resolveCanonicalIn(usage.model, basket);
    const price = normalized
      ? (basket.find((m) => m.model === normalized) ?? null)
      : null;
    let eff: number | null = null;
    let nom: number | null = null;
    if (price) {
      const e = effectiveCost(
        price,
        usage.raw_input_tokens,
        usage.cache_read_tokens,
        usage.cache_creation_tokens,
        usage.output_tokens,
      );
      eff = round(e.effective_usd, 4);
      nom = round(e.nominal_usd, 4);
      totalEff += e.effective_usd;
      totalNom += e.nominal_usd;
    }
    const totalIn =
      usage.raw_input_tokens +
      usage.cache_read_tokens +
      usage.cache_creation_tokens;
    const shortId = usage.session_id.slice(0, 8);
    const modelShort = (normalized ?? usage.model ?? "—").slice(0, 20);
    const when = new Date(f.mtime).toISOString().replace("T", " ").slice(0, 16);
    L.push(
      `  ${pad(shortId, 12)} ${pad(modelShort, 20)} ${pad(String(usage.turns), 5, "r")} ${pad(tokens(totalIn), 8, "r")} ${pad(tokens(usage.output_tokens), 8, "r")} ${pad(money(eff), 10, "r")} ${pad(money(nom), 10, "r")}  ${when}`,
    );
  }

  L.push("");
  L.push(
    `Across ${files.length} sessions: ${money(round(totalEff, 4))} effective · ${money(round(totalNom, 4))} nominal · saved ${money(round(totalNom - totalEff, 4))} via cache`,
  );
  return L.join("\n");
}

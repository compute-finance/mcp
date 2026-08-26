import { readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSessionUsage } from "../storage/session.js";
import { encodeCwd } from "../storage/tools.js";
import {
  resolveModel,
  resolvedToModelPrice,
} from "../oracle/client.js";
import { priceSession } from "../oracle/pricing.js";
import { money, tokens, pad, round } from "./format.js";

export interface ActiveSessionsArgs {
  cwd?: string;
  limit?: number;
  hours?: number;
}

export interface SessionRow {
  session: string;
  model: string;
  prompts: number;
  inferences: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  effective_usd: number | null;
  nominal_usd: number | null;
  last_active: string;
}

export function renderSessionsTable(rows: SessionRow[]): string[] {
  const modelWidth = Math.max("model".length, ...rows.map((r) => r.model.length));
  const out = [
    `  ${pad("session", 12)} ${pad("model", modelWidth)} ${pad("prompts", 7, "r")} ${pad("infs", 5, "r")} ${pad("tools", 5, "r")} ${pad("in-tok", 8, "r")} ${pad("out-tok", 8, "r")} ${pad("effective", 10, "r")} ${pad("nominal", 10, "r")}  last-active`,
  ];
  for (const r of rows) {
    out.push(
      `  ${pad(r.session, 12)} ${pad(r.model, modelWidth)} ${pad(String(r.prompts), 7, "r")} ${pad(String(r.inferences), 5, "r")} ${pad(String(r.tool_calls), 5, "r")} ${pad(tokens(r.input_tokens), 8, "r")} ${pad(tokens(r.output_tokens), 8, "r")} ${pad(money(r.effective_usd), 10, "r")} ${pad(money(r.nominal_usd), 10, "r")}  ${r.last_active}`,
    );
  }
  return out;
}

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

  let totalEff = 0;
  let totalNom = 0;
  let cacheMissingSessions = 0;
  let offBasketSessions = 0;

  const rows = await Promise.all(
    files.map(async (f) => {
      let usage;
      try {
        usage = parseSessionUsage(f.path);
      } catch {
        return null;
      }
      const resolved = await resolveModel(usage.model);
      return { f, usage, resolved };
    }),
  );

  const tableRows: SessionRow[] = [];
  for (const row of rows) {
    if (!row) continue;
    const { f, usage, resolved } = row;
    const normalized =
      resolved && resolved.price_source !== "off-basket"
        ? resolved.resolved_key
        : null;
    const price =
      resolved && normalized ? resolvedToModelPrice(resolved) : null;
    let eff: number | null = null;
    let nom: number | null = null;
    if (price) {
      const r = priceSession(
        price,
        usage.raw_input_tokens,
        usage.cache_read_tokens,
        usage.cache_creation_tokens,
        usage.output_tokens,
      );
      nom = round(r.nominal_usd, 4);
      totalNom += r.nominal_usd;
      if (r.effective) {
        eff = round(r.effective.effective_usd, 4);
        totalEff += r.effective.effective_usd;
      } else {
        cacheMissingSessions += 1;
      }
    } else {
      offBasketSessions += 1;
    }
    tableRows.push({
      session: usage.session_id.slice(0, 8),
      model: normalized ?? usage.model ?? "—",
      prompts: usage.prompts,
      inferences: usage.inferences,
      tool_calls: usage.tool_calls,
      input_tokens:
        usage.raw_input_tokens +
        usage.cache_read_tokens +
        usage.cache_creation_tokens,
      output_tokens: usage.output_tokens,
      effective_usd: eff,
      nominal_usd: nom,
      last_active: new Date(f.mtime).toISOString().replace("T", " ").slice(0, 16),
    });
  }
  L.push(...renderSessionsTable(tableRows));

  L.push("");
  if (cacheMissingSessions === 0) {
    L.push(
      `Across ${files.length} sessions: ${money(round(totalEff, 4))} effective · ${money(round(totalNom, 4))} nominal · saved ${money(round(totalNom - totalEff, 4))} via cache`,
    );
  } else {
    L.push(
      `Across ${files.length} sessions: ${money(round(totalNom, 4))} nominal · effective unavailable for ${cacheMissingSessions} session(s) (oracle has not published cache pricing for the model)`,
    );
  }
  if (offBasketSessions > 0) {
    L.push(
      `${offBasketSessions} session${offBasketSessions === 1 ? "" : "s"} outside SCU coverage (off-basket model, excluded from totals).`,
    );
  }
  return L.join("\n");
}

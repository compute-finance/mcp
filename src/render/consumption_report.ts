import {
  getBasketPrices,
  effectiveCost,
  resolveCanonicalIn,
} from "../oracle/client.js";
import { ModelPrice } from "../oracle/types.js";
import {
  findSessionFile,
  findLatestSessionFile,
} from "../storage/session.js";
import { parseTurns, logTurns, TurnRecord } from "../storage/turns.js";
import { bar, money, tokens, pad, line, round, duration } from "./format.js";

export interface ConsumptionReportArgs {
  session_id?: string;
  cwd?: string;
  full?: boolean;
}

interface TurnWithCost extends TurnRecord {
  effective_usd: number | null;
  nominal_usd: number | null;
  total_tokens: number;
}

export async function renderConsumptionReport(
  args: ConsumptionReportArgs,
): Promise<string> {
  const path = args.session_id
    ? findSessionFile(args.session_id, args.cwd)
    : findLatestSessionFile(args.cwd);
  if (!path) return "Compute Finance Oracle — no session transcript found.";

  const analysis = parseTurns(path);
  let basket: ModelPrice[];
  try {
    basket = await getBasketPrices();
  } catch {
    basket = [];
  }
  const normalized = resolveCanonicalIn(analysis.model, basket);
  const price = normalized
    ? (basket.find((p) => p.model === normalized) ?? null)
    : null;

  const enriched: TurnWithCost[] = analysis.turns.map((t) => {
    const total =
      t.raw_input_tokens +
      t.cache_read_tokens +
      t.cache_creation_tokens +
      t.output_tokens;
    let effective_usd: number | null = null;
    let nominal_usd: number | null = null;
    if (price) {
      const eff = effectiveCost(
        price,
        t.raw_input_tokens,
        t.cache_read_tokens,
        t.cache_creation_tokens,
        t.output_tokens,
      );
      effective_usd = round(eff.effective_usd, 4);
      nominal_usd = round(eff.nominal_usd, 4);
    }
    return { ...t, effective_usd, nominal_usd, total_tokens: total };
  });

  // Persist raw per-turn records (without cost — cost is derivable at read time).
  const logRes = logTurns(analysis.turns);

  const totalEff = enriched.reduce((a, t) => a + (t.effective_usd ?? 0), 0);
  const totalNom = enriched.reduce((a, t) => a + (t.nominal_usd ?? 0), 0);
  const saved = totalNom - totalEff;

  const maxTot = enriched.reduce((m, t) => Math.max(m, t.total_tokens), 0);

  let shown: TurnWithCost[];
  let heading: string;
  if (!args.full && enriched.length > 20) {
    const topByCost = [...enriched]
      .sort((a, b) => (b.effective_usd ?? 0) - (a.effective_usd ?? 0))
      .slice(0, 10);
    const last5 = enriched.slice(-5);
    // Dedupe — a last-5 turn might also be top-by-cost.
    const seen = new Set(topByCost.map((t) => t.turn_index));
    const filtLast = last5.filter((t) => !seen.has(t.turn_index));
    shown = [...topByCost, ...filtLast];
    heading = `Per-turn (top 10 by cost · last 5 — ${analysis.total_turns} total, pass full=true for all):`;
  } else {
    shown = enriched;
    heading =
      enriched.length === 1
        ? "Per-turn (1 turn):"
        : `Per-turn (${enriched.length} turns):`;
  }

  // by_tool — top 6 by calls
  const toolEntries = Object.entries(analysis.by_tool)
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 6);

  const L: string[] = [];
  L.push("Compute Finance Oracle — Session consumption breakdown");
  L.push("Source: api.compute.finance/v1/oracle/basket + local transcript");
  L.push("");
  L.push(
    line(
      `Session: ${analysis.session_id}  ·  Model: ${normalized ?? analysis.model ?? "unknown"}${normalized ? "" : "  (off-basket)"}  ·  Turns: ${analysis.total_turns}  ·  Cache hit: ${(analysis.cache_hit_ratio * 100).toFixed(1)}%`,
    ),
  );
  L.push("");
  if (price) {
    L.push(
      `Total: ${money(round(totalEff, 4))} effective  /  ${money(round(totalNom, 4))} nominal  ·  saved ${money(round(saved, 4))} via cache`,
    );
  } else {
    L.push(
      "Total: off-basket model — per-turn cost columns suppressed, token counts shown.",
    );
  }
  L.push("");

  if (toolEntries.length) {
    L.push("Tokens by tool (calls × turns featuring it):");
    for (const [name, v] of toolEntries) {
      L.push(
        `  ${pad(name, 12)} ${pad(String(v.calls), 4, "r")} calls in ${v.turns_with_tool} turns`,
      );
    }
    L.push("");
  }

  L.push(heading);
  L.push("");
  for (const t of shown) {
    const dur = duration(t.duration_ms);
    const cost = price ? money(t.effective_usd) : "—";
    const toolsTxt =
      t.tools_used.length > 0
        ? `[${[...new Set(t.tools_used)].slice(0, 5).join(", ")}${t.tools_used.length > 5 ? "…" : ""}]`
        : "[—]";
    L.push(
      `  T${pad(String(t.turn_index), 3, "r")} ${bar(t.total_tokens, maxTot)} ${pad(tokens(t.total_tokens), 6, "r")}tok  ${pad(cost, 7, "r")}  ${pad(dur, 7, "r")}  ${toolsTxt}`,
    );
    L.push(`         ${t.comment}`);
  }
  L.push("");

  // Mechanical facts
  if (enriched.length && price) {
    const sortedCost = [...enriched].sort(
      (a, b) => (b.effective_usd ?? 0) - (a.effective_usd ?? 0),
    );
    const most = sortedCost[0];
    const cheap = sortedCost[sortedCost.length - 1];
    const warm = [...enriched]
      .filter((t) => t.raw_input_tokens + t.cache_read_tokens >= 10_000)
      .sort(
        (a, b) =>
          b.cache_read_tokens / (b.raw_input_tokens + b.cache_read_tokens) -
          a.cache_read_tokens / (a.raw_input_tokens + a.cache_read_tokens),
      )[0];
    const mostTool = toolEntries[0];

    L.push("Mechanical facts:");
    L.push(
      `  Most expensive turn:  T${most.turn_index}  ${money(most.effective_usd)}   comment: "${most.comment}"`,
    );
    L.push(
      `  Cheapest turn:        T${cheap.turn_index}  ${money(cheap.effective_usd)}   comment: "${cheap.comment}"`,
    );
    if (warm) {
      const ratio =
        warm.cache_read_tokens / (warm.raw_input_tokens + warm.cache_read_tokens);
      L.push(
        `  Warmest cache turn:   T${warm.turn_index}  ${(ratio * 100).toFixed(1)}% cache reads   (input ≥10k tokens)`,
      );
    }
    if (mostTool) {
      L.push(
        `  Most-called tool:     ${mostTool[0]}  ${mostTool[1].calls} calls across ${mostTool[1].turns_with_tool} turns`,
      );
    }
    L.push("");
  }

  L.push(`${logRes.logged} turns logged to ${logRes.path}`);
  return L.join("\n");
}

import {
  getBasketPrices,
  priceSession,
  OracleCachePricingMissingError,
  resolveCanonicalIn,
} from "../oracle/client.js";
import { ModelPrice } from "../oracle/types.js";
import {
  findSessionFile,
  findLatestSessionFile,
  parseTranscript,
} from "../storage/transcript.js";
import { summarizeSession } from "../storage/session.js";
import {
  analyzeInferences,
  logInferences,
  LoggedInference,
} from "../storage/inferences.js";
import { bar, money, tokens, pad, line, round, duration } from "./format.js";

export interface ConsumptionReportArgs {
  session_id?: string;
  cwd?: string;
  full?: boolean;
}

interface InferenceWithCost extends LoggedInference {
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

  const transcript = parseTranscript(path);
  const analysis = analyzeInferences(transcript);
  const summary = summarizeSession(transcript);

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

  const cacheState: {
    missingCount: number;
    first: OracleCachePricingMissingError | null;
  } = { missingCount: 0, first: null };
  const enriched: InferenceWithCost[] = analysis.inferences.map((inf) => {
    const total =
      inf.raw_input_tokens +
      inf.cache_read_tokens +
      inf.cache_creation_tokens +
      inf.output_tokens;
    let effective_usd: number | null = null;
    let nominal_usd: number | null = null;
    if (price) {
      const r = priceSession(
        price,
        inf.raw_input_tokens,
        inf.cache_read_tokens,
        inf.cache_creation_tokens,
        inf.output_tokens,
      );
      nominal_usd = round(r.nominal_usd, 4);
      if (r.effective) {
        effective_usd = round(r.effective.effective_usd, 4);
      } else if (r.cache_pricing_missing) {
        cacheState.missingCount += 1;
        if (cacheState.first === null) cacheState.first = r.cache_pricing_missing;
      }
    }
    return { ...inf, effective_usd, nominal_usd, total_tokens: total };
  });

  const logRes = logInferences(analysis.inferences);

  const totalEff = enriched.reduce((a, t) => a + (t.effective_usd ?? 0), 0);
  const totalNom = enriched.reduce((a, t) => a + (t.nominal_usd ?? 0), 0);
  const saved = totalNom - totalEff;

  const maxTot = enriched.reduce((m, t) => Math.max(m, t.total_tokens), 0);

  let shown: InferenceWithCost[];
  let heading: string;
  if (!args.full && enriched.length > 20) {
    const topByCost = [...enriched]
      .sort((a, b) => (b.effective_usd ?? 0) - (a.effective_usd ?? 0))
      .slice(0, 10);
    const last5 = enriched.slice(-5);
    const seen = new Set(topByCost.map((t) => t.index));
    const filtLast = last5.filter((t) => !seen.has(t.index));
    shown = [...topByCost, ...filtLast];
    heading = `Per-inference (top 10 by cost · last 5 — ${analysis.total_inferences} total, pass full=true for all):`;
  } else {
    shown = enriched;
    heading =
      enriched.length === 1
        ? "Per-inference (1 inference):"
        : `Per-inference (${enriched.length} inferences):`;
  }

  const toolEntries = Object.entries(analysis.by_tool)
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 6);

  const L: string[] = [];
  L.push("Compute Finance Oracle — Session consumption breakdown");
  L.push("Source: api.compute.finance/v1/oracle/basket + local transcript");
  L.push("");
  L.push(
    line(
      `Session: ${analysis.session_id}  ·  Model: ${normalized ?? analysis.model ?? "unknown"}${normalized ? "" : "  (off-basket)"}`,
    ),
  );
  L.push(
    line(
      `Prompts: ${summary.prompts}  ·  Inferences: ${summary.inferences}  ·  Tool calls: ${summary.tool_calls}  ·  Cache hit: ${(analysis.cache_hit_ratio * 100).toFixed(1)}%`,
    ),
  );
  L.push("");
  if (price && cacheState.missingCount === 0) {
    L.push(
      `Total: ${money(round(totalEff, 4))} effective  /  ${money(round(totalNom, 4))} nominal  ·  saved ${money(round(saved, 4))} via cache`,
    );
  } else if (price && cacheState.first !== null) {
    L.push(
      `Total: ${money(round(totalNom, 4))} nominal  ·  effective unavailable for ${cacheState.missingCount} inference(s) — oracle has not published ${cacheState.first.missing} pricing for ${cacheState.first.model}`,
    );
  } else {
    L.push(
      "Total: off-basket model — per-inference cost columns suppressed, token counts shown.",
    );
  }
  L.push("");

  if (toolEntries.length) {
    L.push("Tokens by tool (calls × inferences featuring it):");
    for (const [name, v] of toolEntries) {
      L.push(
        `  ${pad(name, 12)} ${pad(String(v.calls), 4, "r")} calls in ${v.inferences_with_tool} inferences`,
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
      `  I${pad(String(t.index), 3, "r")} ${bar(t.total_tokens, maxTot)} ${pad(tokens(t.total_tokens), 6, "r")}tok  ${pad(cost, 7, "r")}  ${pad(dur, 7, "r")}  ${toolsTxt}`,
    );
    L.push(`         ${t.comment}`);
  }
  L.push("");

  if (enriched.length && price) {
    const useNominal = cacheState.missingCount > 0;
    const pickCost = (t: InferenceWithCost) =>
      useNominal ? t.nominal_usd : t.effective_usd;
    const sortedCost = [...enriched].sort(
      (a, b) => (pickCost(b) ?? 0) - (pickCost(a) ?? 0),
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
    const costLabel = useNominal ? "nominal" : "effective";

    L.push("Mechanical facts:");
    L.push(
      `  Most expensive inference (${costLabel}):  I${most.index}  ${money(pickCost(most))}   comment: "${most.comment}"`,
    );
    L.push(
      `  Cheapest inference (${costLabel}):        I${cheap.index}  ${money(pickCost(cheap))}   comment: "${cheap.comment}"`,
    );
    if (warm) {
      const ratio =
        warm.cache_read_tokens / (warm.raw_input_tokens + warm.cache_read_tokens);
      L.push(
        `  Warmest cache inference:   I${warm.index}  ${(ratio * 100).toFixed(1)}% cache reads   (input ≥10k tokens)`,
      );
    }
    if (mostTool) {
      L.push(
        `  Most-called tool:          ${mostTool[0]}  ${mostTool[1].calls} calls across ${mostTool[1].inferences_with_tool} inferences`,
      );
    }
    L.push("");
  }

  L.push(`${logRes.logged} inferences logged to ${logRes.path}`);
  return L.join("\n");
}

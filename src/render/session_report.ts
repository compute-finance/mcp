import {
  getBasketPrices,
  getActiveMethodologyVersion,
  getScuValue,
  priceSession,
  OracleCachePricingMissingError,
  costUsd,
  resolveCanonicalIn,
} from "../oracle/client.js";
import {
  findSessionFile,
  findLatestSessionFile,
  parseSessionUsage,
  UsageTotals,
} from "../storage/session.js";
import { logSession, getStats } from "../storage/history.js";
import { classifyProfile } from "../storage/profile.js";
import { ModelPrice, ScuValue } from "../oracle/types.js";
import { money, tokens, line, round, scuAmount, scuPrice } from "./format.js";

// "Net realized vs market" synthesis line — deferred until its formula is agreed.
const SCU_SYNTHESIS_ENABLED = false;

export interface SessionReportArgs {
  session_id?: string;
  cwd?: string;
}

function pickCheapestByFamily(basket: ModelPrice[]): ModelPrice[] {
  const byFamily = new Map<string, ModelPrice>();
  for (const p of basket) {
    const key = p.family || `${p.provider}.${p.model}`;
    const existing = byFamily.get(key);
    const cost = p.input_usd_per_million + p.output_usd_per_million;
    if (
      !existing ||
      cost < existing.input_usd_per_million + existing.output_usd_per_million
    ) {
      byFamily.set(key, p);
    }
  }
  return Array.from(byFamily.values()).sort(
    (a, b) =>
      a.input_usd_per_million + a.output_usd_per_million -
      (b.input_usd_per_million + b.output_usd_per_million),
  );
}

export interface ScuPositionArgs {
  scu: ScuValue;
  effective_usd: number | null;
  nominal_usd: number | null;
  price: ModelPrice | null;
  synthesis?: boolean;
}

// SCU-denominated position block; each line is gated on its data, market reference always renders.
function buildScuPosition(a: ScuPositionArgs): string[] {
  const { scu, effective_usd, nominal_usd, price } = a;
  const scuUsd = scu.scuUsd;

  const rows: Array<[label: string, value: string]> = [];

  // Session size: effective is the normal path; nominal is the tagged fallback if cache pricing is absent.
  const basis =
    effective_usd !== null
      ? { usd: effective_usd, label: "effective" }
      : nominal_usd !== null
        ? { usd: nominal_usd, label: "nominal" }
        : null;
  if (basis) {
    rows.push([
      "Session size:",
      `${scuAmount(basis.usd / scuUsd)} SCU   (${money(basis.usd)} ${basis.label} · ${scuPrice(scuUsd)} / SCU)`,
    ]);
  }

  // list-to-list × index, joined by family; stamped so a basket reconstitution isn't mistaken for drift.
  const rep = price
    ? scu.familyRepresentatives.find((f) => f.family === price.family) ?? null
    : null;
  if (price && rep) {
    const idx = rep.blendedCostUsd / scuUsd;
    const date = scu.updatedAt ? scu.updatedAt.slice(0, 10) : "";
    const stamp = `@ SCU ${scuPrice(scuUsd)}${date ? ` · ${date}` : ""}`;
    rows.push([
      `Your model (${price.display_name}):`,
      `${idx.toFixed(1)}× index   (list-to-list: model blended ÷ SCU index)  ${stamp}`,
    ]);
  }

  // Market reference (always renders); "geo-mean" is the v1 descriptor, other versions stay neutral.
  const meanWord = scu.methodologyVersion === 1 ? "geo-mean" : "blend";
  rows.push([
    "Market reference:",
    `SCU = ${scuPrice(scuUsd)} · ${meanWord} of ${scu.familyRepresentatives.length} model families`,
  ]);

  // Provisional, gated off until agreed: list × index discounted by the realized cache ratio.
  if (
    a.synthesis &&
    rep &&
    effective_usd !== null &&
    nominal_usd !== null &&
    nominal_usd > 0
  ) {
    const realized = (rep.blendedCostUsd / scuUsd) * (effective_usd / nominal_usd);
    rows.push([
      "Net realized:",
      `${realized.toFixed(1)}× index   (list × index after your cache discount)`,
    ]);
  }

  const width = Math.max(...rows.map(([l]) => l.length));
  const out = ["SCU position"];
  for (const [label, value] of rows) {
    out.push(`  ${label.padEnd(width)}  ${value}`);
  }
  return out;
}

export async function renderSessionReport(
  args: SessionReportArgs,
): Promise<string> {
  const path = args.session_id
    ? findSessionFile(args.session_id, args.cwd)
    : findLatestSessionFile(args.cwd);
  if (!path) return "Compute Finance Oracle — no session transcript found.";

  const usage = parseSessionUsage(path);
  const { profile, out_in_ratio } = classifyProfile(usage);

  let basket: ModelPrice[];
  try {
    basket = await getBasketPrices();
  } catch (err) {
    // Oracle unreachable: raw usage only, DO NOT log.
    return renderOracleUnreachable(usage, profile, err as Error);
  }

  const normalized = resolveCanonicalIn(usage.model, basket);
  const methodologyVersion = await getActiveMethodologyVersion();

  // Separate endpoint from the basket — on failure just omit the block, don't sink the report.
  let scu: ScuValue | null = null;
  try {
    scu = await getScuValue();
  } catch {
    scu = null;
  }

  const totalIn =
    usage.raw_input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;

  let effective_usd: number | null = null;
  let nominal_usd: number | null = null;
  let cacheNote = "";
  let cachePricingMissing: OracleCachePricingMissingError | null = null;
  let sessionPrice: ModelPrice | null = null;
  if (normalized) {
    sessionPrice = basket.find((p) => p.model === normalized) ?? null;
    if (sessionPrice) {
      const r = priceSession(
        sessionPrice,
        usage.raw_input_tokens,
        usage.cache_read_tokens,
        usage.cache_creation_tokens,
        usage.output_tokens,
      );
      nominal_usd = round(r.nominal_usd, 4);
      if (r.effective) {
        effective_usd = round(r.effective.effective_usd, 4);
        cacheNote = r.effective.notes[0];
      } else {
        cachePricingMissing = r.cache_pricing_missing;
      }
    }
  }

  const log = logSession({
    session_id: usage.session_id,
    model: normalized,
    in_basket: normalized !== null,
    profile,
    raw_input_tokens: usage.raw_input_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    output_tokens: usage.output_tokens,
    prompts: usage.prompts,
    inferences: usage.inferences,
    tool_calls: usage.tool_calls,
    edits: usage.edits,
    reads: usage.reads,
    extended_thinking_used: usage.extended_thinking_used,
    effective_usd,
    nominal_usd,
    out_in_ratio,
  });
  void log;

  const stats = await getStats(basket);

  const counterfactual = pickCheapestByFamily(basket);

  // Strip `claude-` prefix so counterfactual rows stay tight (`opus-4.6` vs `claude-opus-4.6`).
  const shortName = (m: string) => m.replace(/^claude-/, "");
  const fmtCounterfactualRow = (p: ModelPrice) =>
    `${p.family.padEnd(22)} ${shortName(p.model)} ${money(round(costUsd(p, totalIn, usage.output_tokens), 4))}`;

  const L: string[] = [];
  L.push("Compute Finance Oracle — Session analysis");
  L.push(
    `Source: api.compute.finance/v1/oracle/basket + local transcript (measured)${
      methodologyVersion === null ? "" : ` · oracle methodology v${methodologyVersion}`
    }`,
  );
  L.push("");
  L.push(
    line(
      `Session: ${usage.session_id}  ·  Model: ${normalized ?? usage.model ?? "unknown"}${normalized ? "" : "  (off-basket)"}`,
    ),
  );
  L.push("");
  L.push("Tokens:");
  L.push(
    `  Input ${tokens(usage.raw_input_tokens)} raw · ${tokens(usage.cache_read_tokens)} cache-read · ${tokens(usage.cache_creation_tokens)} cache-create · ${tokens(usage.output_tokens)} output`,
  );
  L.push(
    `  ${usage.prompts} prompts · ${usage.inferences} inferences · ${usage.tool_calls} tool calls · ${usage.edits} edits · ${usage.reads} reads · thinking ${usage.extended_thinking_used ? "yes" : "no"}`,
  );
  L.push("");
  if (effective_usd !== null && nominal_usd !== null) {
    L.push("Cost (this session):");
    L.push(`  Effective (cache-aware):  ${money(effective_usd)}`);
    L.push(`  Nominal (no cache):       ${money(nominal_usd)}`);
    L.push(
      `  Saved by caching:         ${money(round(nominal_usd - effective_usd, 4))}`,
    );
    if (cacheNote) L.push(`  ${cacheNote}`);
  } else if (cachePricingMissing !== null && nominal_usd !== null) {
    L.push("Cost (this session):");
    L.push(`  Nominal (no cache discount):  ${money(nominal_usd)}`);
    L.push(
      `  Effective (cache-aware):      unavailable — oracle has not published ${cachePricingMissing.missing} pricing for ${cachePricingMissing.model}`,
    );
  } else {
    L.push("Cost (this session):");
    L.push("  Current model not tracked by oracle — effective cost unavailable.");
  }
  if (scu) {
    L.push("");
    for (const l of buildScuPosition({
      scu,
      effective_usd,
      nominal_usd,
      price: sessionPrice,
      synthesis: SCU_SYNTHESIS_ENABLED,
    })) {
      L.push(l);
    }
  }
  L.push("");
  L.push("Same shape on alternatives (cheapest representative per family, nominal):");
  for (const p of counterfactual) L.push(`  ${fmtCounterfactualRow(p)}`);
  L.push("");
  L.push(`Profile: ${profile}`);

  if (stats.sample_size >= 3) {
    const prof = stats.by_profile[profile];
    L.push("");
    L.push(
      `Your history (n=${stats.distinct_sessions} sessions · ${money(stats.cumulative_effective_usd)} effective cumulative, ${money(stats.cumulative_nominal_usd)} nominal):`,
    );
    if (prof && prof.median_effective_usd > 0 && effective_usd !== null) {
      const ratio = effective_usd / prof.median_effective_usd - 1;
      const direction = ratio >= 0 ? "above" : "below";
      L.push(
        `  This profile (${profile}): median ${money(prof.median_effective_usd)}  ·  this session ${money(effective_usd)}  →  ${Math.abs(Math.round(ratio * 100))}% ${direction} typical`,
      );
    }
  }

  for (const ins of stats.insights) {
    L.push("");
    L.push(`Insight: ${ins.message}`);
  }

  L.push("");
  L.push(`Session #${stats.distinct_sessions} logged.`);

  return L.join("\n");
}

function renderOracleUnreachable(
  usage: UsageTotals,
  profile: string,
  err: Error,
): string {
  const L: string[] = [];
  L.push("Compute Finance Oracle — Session analysis");
  L.push("Source: local transcript only (oracle unreachable)");
  L.push("");
  L.push(`Session: ${usage.session_id}  ·  Model: ${usage.model ?? "unknown"}`);
  L.push("");
  L.push("Tokens:");
  L.push(
    `  Input ${tokens(usage.raw_input_tokens)} raw · ${tokens(usage.cache_read_tokens)} cache-read · ${tokens(usage.cache_creation_tokens)} cache-create · ${tokens(usage.output_tokens)} output`,
  );
  L.push(
    `  ${usage.prompts} prompts · ${usage.inferences} inferences · ${usage.tool_calls} tool calls · ${usage.edits} edits · ${usage.reads} reads · thinking ${usage.extended_thinking_used ? "yes" : "no"}`,
  );
  L.push("");
  L.push(`Profile: ${profile}`);
  L.push("");
  L.push(`oracle unreachable — pricing skipped (${err.message}). Session NOT logged.`);
  return L.join("\n");
}

export const _internals = {
  pickCheapestByFamily,
  buildScuPosition,
};

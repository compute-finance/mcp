import {
  getBasketPrices,
  getActiveMethodologyVersion,
  getScuValue,
  priceSession,
  OracleCachePricingMissingError,
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
import { money, tokens, line, round, scuAmount, scuPrice, multiple } from "./format.js";

// "Net realized vs market" synthesis line — deferred until its formula is agreed.
const SCU_SYNTHESIS_ENABLED = false;

export interface SessionReportArgs {
  session_id?: string;
  cwd?: string;
}

export interface XIndexLadderArgs {
  scu: ScuValue;
  basket: ModelPrice[];
  // The session's current model (a basket family representative), or null when off-basket.
  price: ModelPrice | null;
}

interface LadderRow {
  provider_name: string;
  display_name: string;
  x_index: number;
  is_current: boolean;
}

// "How many × cheaper per unit of work" — whole number from 3×, one decimal below (`5×`, `1.7×`).
function cheaperFactor(ratio: number): string {
  return `${ratio >= 3 ? ratio.toFixed(0) : ratio.toFixed(1)}×`;
}

// Each basket family's list price as × SCU on the fixed reference workload, framed relative to the
// dev's current model. Grouped by provider, flagship (priciest) first; the dev's provider leads.
// Blended costs come from the SCU breakdown (the same raw prices the index is built from) — NOT the
// basket's marked-up prices, which would not reconcile with the index.
function buildXIndexLadder(a: XIndexLadderArgs): string[] {
  const { scu, basket, price } = a;
  const scuUsd = scu.scuUsd;

  // family is the shared key between the SCU breakdown and the basket (one model per family).
  const basketByFamily = new Map(basket.map((b) => [b.family, b]));
  const rows: LadderRow[] = [];
  for (const rep of scu.familyRepresentatives) {
    const bp = basketByFamily.get(rep.family);
    if (!bp) continue; // representative without a basket row — skip rather than guess a label.
    rows.push({
      provider_name: bp.provider_name,
      display_name: bp.display_name,
      x_index: rep.blendedCostUsd / scuUsd,
      is_current: price !== null && bp.family === price.family,
    });
  }
  if (rows.length === 0) return [];

  const current = rows.find((r) => r.is_current) ?? null;
  const cur = current ? current.x_index : null;

  // Provider order: the dev's provider first, then by each provider's flagship (max × index) desc.
  const flagshipX = new Map<string, number>();
  for (const r of rows) {
    flagshipX.set(r.provider_name, Math.max(flagshipX.get(r.provider_name) ?? -Infinity, r.x_index));
  }
  const curProvider = current?.provider_name ?? null;
  const providers = [...new Set(rows.map((r) => r.provider_name))].sort((x, y) => {
    if (x === curProvider) return -1;
    if (y === curProvider) return 1;
    return flagshipX.get(y)! - flagshipX.get(x)! || x.localeCompare(y);
  });

  const nameW = Math.max(...rows.map((r) => r.display_name.length));
  const out: string[] = [];
  out.push("× index ladder (list price per unit of work · reference workload, not this session)");
  out.push(
    cur !== null && current
      ? `You're on ${current.display_name} (${multiple(cur)} index).`
      : price === null
        ? "Your model is off-basket — showing absolute × index (no comparison anchor)."
        // In the basket but absent from the current SCU breakdown (a cross-endpoint reconstitution
        // race): no blended cost to anchor on, so fall back to the absolute ladder without claiming off-basket.
        : "Your model isn't in the current SCU index — showing absolute × index (no comparison anchor).",
  );
  for (const p of providers) {
    out.push(`  ${p}`);
    const provRows = rows
      .filter((r) => r.provider_name === p)
      .sort((x, y) => y.x_index - x.x_index || x.display_name.localeCompare(y.display_name));
    for (const r of provRows) {
      let tag: string;
      if (r.is_current) {
        tag = "← your model";
      } else if (cur === null) {
        tag = ""; // off-basket: no anchor to compare against.
      } else {
        const factor = cur / r.x_index;
        tag =
          Math.abs(factor - 1) < 0.02
            ? "≈ parity"
            : factor > 1
              ? `~${cheaperFactor(factor)} cheaper`
              : "pricier";
      }
      out.push(line(`    ${r.display_name.padEnd(nameW)}  ${multiple(r.x_index).padStart(6)}   ${tag}`));
    }
  }
  return out;
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
    const ladder = buildXIndexLadder({ scu, basket, price: sessionPrice });
    if (ladder.length) {
      L.push("");
      for (const l of ladder) L.push(l);
    }
  }
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
  buildScuPosition,
  buildXIndexLadder,
};

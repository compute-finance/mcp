import type { ModelPrice, ScuValue } from "../../oracle/types.js";
import { line, multiple } from "../format.js";

export interface XIndexLadderArgs {
  scu: ScuValue;
  basket: ModelPrice[];
  price: ModelPrice | null;
}

interface LadderRow {
  provider_name: string;
  display_name: string;
  x_index: number;
  is_current: boolean;
}

function cheaperFactor(ratio: number): string {
  return `${ratio >= 3 ? ratio.toFixed(0) : ratio.toFixed(1)}×`;
}

export function renderXIndexLadderBlock(a: XIndexLadderArgs): string[] {
  const { scu, basket, price } = a;
  const scuUsd = scu.scuUsd;

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

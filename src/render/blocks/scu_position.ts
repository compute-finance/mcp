import type { ModelPrice, ScuValue } from "../../oracle/types.js";
import { money, scuAmount, scuPrice } from "../format.js";

export interface ScuPositionArgs {
  scu: ScuValue;
  effective_usd: number | null;
  nominal_usd: number | null;
  price: ModelPrice | null;
  synthesis?: boolean;
}

export function renderScuPositionBlock(a: ScuPositionArgs): string[] {
  const { scu, effective_usd, nominal_usd, price } = a;
  const scuUsd = scu.scuUsd;

  const rows: Array<[label: string, value: string]> = [];

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

  const meanWord = scu.methodologyVersion === 1 ? "geo-mean" : "blend";
  rows.push([
    "Market reference:",
    `SCU = ${scuPrice(scuUsd)} · ${meanWord} of ${scu.familyRepresentatives.length} model families`,
  ]);

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

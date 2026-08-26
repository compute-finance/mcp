import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderScuPositionBlock } from "./scu_position.js";
import type {
  ModelPrice,
  ScuFamilyRepresentative,
  ScuValue,
} from "../../oracle/types.js";

function mp(overrides: Partial<ModelPrice> & Pick<ModelPrice, "model" | "family">): ModelPrice {
  return {
    model: overrides.model,
    display_name: overrides.model,
    provider: "test",
    provider_name: "Test",
    family: overrides.family,
    released_at: null,
    base_input_usd_per_million: 0,
    base_output_usd_per_million: 0,
    base_input_wei_per_million: 0,
    base_output_wei_per_million: 0,
    cache: null,
    reasoning: null,
    ...overrides,
  };
}

// Live SCU shape (per ticket): scuUsd ≈ 0.0024346, 18 families, Opus family blended 0.0175.
const OPUS_FAMILY = "anthropic.claude-opus";

function rep(
  overrides: Partial<ScuFamilyRepresentative> & Pick<ScuFamilyRepresentative, "family">,
): ScuFamilyRepresentative {
  return {
    family: overrides.family,
    modelKey: overrides.modelKey ?? `${overrides.family}-model`,
    inputPriceUsdPerMillion: 15,
    outputPriceUsdPerMillion: 75,
    blendedCostUsd: 0.0175,
    ...overrides,
  };
}

function scuVal(overrides: Partial<ScuValue> = {}): ScuValue {
  // 18 reps like the live basket; the Opus family's 0.0175 blend gives the spec's 7.2× index.
  const reps: ScuFamilyRepresentative[] = [
    rep({ family: OPUS_FAMILY, blendedCostUsd: 0.0175 }),
  ];
  for (let i = 1; i < 18; i++) reps.push(rep({ family: `fam.${i}`, blendedCostUsd: 0.01 }));
  return {
    scuUsd: 0.0024346,
    computeIndex: 100,
    methodologyVersion: 1,
    updatedAt: "2026-06-20T12:00:00Z",
    familyRepresentatives: reps,
    ...overrides,
  };
}

const opusPrice = mp({
  model: "claude-opus-4.7",
  display_name: "Opus",
  family: OPUS_FAMILY,
});

function lineWith(lines: string[], needle: string): string | undefined {
  return lines.find((l) => l.includes(needle));
}

describe("renderScuPositionBlock", () => {
  it("SHOULD always start with the 'SCU position' header line", () => {
    const out = renderScuPositionBlock({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    assert.equal(out[0], "SCU position");
  });

  it("SHOULD size the session in SCU as effective_usd / scuUsd and tag it 'effective'", () => {
    const out = renderScuPositionBlock({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    const sizeLine = lineWith(out, "Session size:");
    assert.ok(sizeLine, "session size line must render when effective_usd is present");
    // 52 / 0.0024346 = 21,359 SCU.
    assert.match(sizeLine!, /21,359 SCU/);
    assert.ok(sizeLine!.includes("$52.00 effective"), "must show the effective basis money + word");
    assert.ok(sizeLine!.includes("$0.002435 / SCU"), "must show the SCU unit price");
  });

  it("SHOULD fall back to nominal_usd and tag the line 'nominal' when effective_usd is null", () => {
    const out = renderScuPositionBlock({
      scu: scuVal(),
      effective_usd: null,
      nominal_usd: 60,
      price: opusPrice,
    });
    const sizeLine = lineWith(out, "Session size:");
    assert.ok(sizeLine, "session size line must still render from nominal");
    // 60 / 0.0024346 = 24,644.7 → 24,645 SCU.
    assert.match(sizeLine!, /24,645 SCU/);
    assert.ok(sizeLine!.includes("nominal"), "fallback line must carry the word 'nominal'");
    assert.ok(!sizeLine!.includes("effective"), "fallback line must NOT claim 'effective' basis");
  });

  it("SHOULD compute the × index as the family's blendedCostUsd / scuUsd to one decimal", () => {
    const out = renderScuPositionBlock({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    const idxLine = lineWith(out, "Your model");
    assert.ok(idxLine, "× index line must render when price family is in the breakdown");
    // 0.0175 / 0.0024346 = 7.188 → 7.2.
    assert.match(idxLine!, /7\.2× index/);
  });

  it("SHOULD embed the model display name in the × index label", () => {
    const out = renderScuPositionBlock({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    const idxLine = lineWith(out, "Your model");
    assert.ok(idxLine!.includes("Opus"), "label must embed price.display_name");
  });

  it("SHOULD stamp the × index line with the SCU value and the updatedAt date (drift stamp)", () => {
    const out = renderScuPositionBlock({
      scu: scuVal({ updatedAt: "2026-06-20T12:00:00Z" }),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    const idxLine = lineWith(out, "Your model");
    assert.ok(idxLine!.includes("@ SCU $0.002435"), "stamp must carry the SCU unit price");
    assert.ok(idxLine!.includes("2026-06-20"), "stamp must carry the YYYY-MM-DD from updatedAt");
  });

  it("SHOULD always render the market-reference line with the SCU price and family count", () => {
    const out = renderScuPositionBlock({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    const refLine = lineWith(out, "Market reference:");
    assert.ok(refLine, "market reference line must always render");
    assert.ok(refLine!.includes("SCU = $0.002435"), "must show the live SCU price");
    assert.ok(refLine!.includes("18 model families"), "family count = familyRepresentatives.length");
  });

  it("SHOULD describe the v1 mean as 'geo-mean'", () => {
    const out = renderScuPositionBlock({
      scu: scuVal({ methodologyVersion: 1 }),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    const refLine = lineWith(out, "Market reference:");
    assert.ok(refLine!.includes("geo-mean"), "methodology v1 uses the geo-mean descriptor");
  });

  it("SHOULD NOT claim 'geo-mean' for a non-v1 methodology version", () => {
    const out = renderScuPositionBlock({
      scu: scuVal({ methodologyVersion: 2 }),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    const refLine = lineWith(out, "Market reference:");
    assert.ok(
      !refLine!.includes("geo-mean"),
      "a different methodology must not be mislabelled as a geo-mean",
    );
  });

  it("SHOULD render ONLY the header + market reference when there is no cost basis and no price", () => {
    // Off-basket + no effective/nominal: only the model-independent market reference renders.
    const out = renderScuPositionBlock({
      scu: scuVal(),
      effective_usd: null,
      nominal_usd: null,
      price: null,
    });
    assert.equal(out[0], "SCU position");
    assert.equal(lineWith(out, "Session size:"), undefined, "no basis → no session size line");
    assert.equal(lineWith(out, "Your model"), undefined, "no price → no × index line");
    assert.ok(lineWith(out, "Market reference:"), "market reference must still render");
    assert.equal(out.length, 2, "exactly the header + market reference, nothing else");
  });

  it("SHOULD omit the × index line when the model's family is not in the breakdown, but keep size + reference", () => {
    const out = renderScuPositionBlock({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: mp({ model: "mystery-1", display_name: "Mystery", family: "vendor.unknown" }),
    });
    assert.equal(lineWith(out, "Your model"), undefined, "no matching family → no × index line");
    assert.ok(lineWith(out, "Session size:"), "session size still renders");
    assert.ok(lineWith(out, "Market reference:"), "market reference still renders");
  });

  it("SHOULD NOT render the 'Net realized' synthesis line when synthesis is omitted (default off)", () => {
    const out = renderScuPositionBlock({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    assert.equal(lineWith(out, "Net realized"), undefined, "synthesis line is gated off by default");
  });

  it("SHOULD NOT render the synthesis line when synthesis is explicitly false", () => {
    const out = renderScuPositionBlock({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
      synthesis: false,
    });
    assert.equal(lineWith(out, "Net realized"), undefined);
  });

  it("SHOULD render the 'Net realized' line when synthesis is on AND effective + nominal + matching family are present", () => {
    const out = renderScuPositionBlock({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
      synthesis: true,
    });
    assert.ok(lineWith(out, "Net realized"), "synthesis line appears when the flag is on and inputs exist");
  });
});

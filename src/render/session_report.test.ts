import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _internals } from "./session_report.js";
import type {
  ModelPrice,
  ScuValue,
  ScuFamilyRepresentative,
} from "../oracle/types.js";

const { buildXIndexLadder, buildScuPosition } = _internals;

function mp(overrides: Partial<ModelPrice> & Pick<ModelPrice, "model" | "family">): ModelPrice {
  return {
    model: overrides.model,
    display_name: overrides.model,
    provider: "test",
    provider_name: "Test",
    family: overrides.family,
    released_at: null,
    input_usd_per_million: 0,
    output_usd_per_million: 0,
    input_wei_per_million: 0,
    output_wei_per_million: 0,
    cache: null,
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

describe("buildScuPosition", () => {
  it("SHOULD always start with the 'SCU position' header line", () => {
    const out = buildScuPosition({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    assert.equal(out[0], "SCU position");
  });

  it("SHOULD size the session in SCU as effective_usd / scuUsd and tag it 'effective'", () => {
    const out = buildScuPosition({
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
    const out = buildScuPosition({
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
    const out = buildScuPosition({
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
    const out = buildScuPosition({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    const idxLine = lineWith(out, "Your model");
    assert.ok(idxLine!.includes("Opus"), "label must embed price.display_name");
  });

  it("SHOULD stamp the × index line with the SCU value and the updatedAt date (drift stamp)", () => {
    const out = buildScuPosition({
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
    const out = buildScuPosition({
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
    const out = buildScuPosition({
      scu: scuVal({ methodologyVersion: 1 }),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    const refLine = lineWith(out, "Market reference:");
    assert.ok(refLine!.includes("geo-mean"), "methodology v1 uses the geo-mean descriptor");
  });

  it("SHOULD NOT claim 'geo-mean' for a non-v1 methodology version", () => {
    const out = buildScuPosition({
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
    const out = buildScuPosition({
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
    const out = buildScuPosition({
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
    const out = buildScuPosition({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
    });
    assert.equal(lineWith(out, "Net realized"), undefined, "synthesis line is gated off by default");
  });

  it("SHOULD NOT render the synthesis line when synthesis is explicitly false", () => {
    const out = buildScuPosition({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
      synthesis: false,
    });
    assert.equal(lineWith(out, "Net realized"), undefined);
  });

  it("SHOULD render the 'Net realized' line when synthesis is on AND effective + nominal + matching family are present", () => {
    const out = buildScuPosition({
      scu: scuVal(),
      effective_usd: 52,
      nominal_usd: 60,
      price: opusPrice,
      synthesis: true,
    });
    assert.ok(lineWith(out, "Net realized"), "synthesis line appears when the flag is on and inputs exist");
  });
});

describe("buildXIndexLadder", () => {
  // Deterministic fixture: scuUsd = 0.001 so x_index = blendedCostUsd * 1000 (exact, no float noise).
  // Two providers, current model = Opus (Anthropic). Chosen so the relative tags hit every branch:
  //   cur (Opus) = 8×.  Sonnet 4× → 8/4 = 2.0× cheaper (one-decimal branch).
  //   Haiku 1× → 8/1 = 8× cheaper (integer branch).  GPT-5 10× → 8/10 = 0.8 → pricier.
  //   GPT-Mini 2× → 8/2 = 4× cheaper.  OpenAI flagship (10×) > Anthropic flagship (8×).
  const LADDER_SCU_USD = 0.001;

  function ladderRep(family: string, blendedCostUsd: number): ScuFamilyRepresentative {
    return {
      family,
      modelKey: `${family}-model`,
      inputPriceUsdPerMillion: 0,
      outputPriceUsdPerMillion: 0,
      blendedCostUsd,
    };
  }

  // Order of reps is deliberately NOT sorted — the builder must impose its own ordering.
  function ladderScu(reps: ScuFamilyRepresentative[]): ScuValue {
    return {
      scuUsd: LADDER_SCU_USD,
      computeIndex: 100,
      methodologyVersion: 1,
      updatedAt: "2026-06-20T12:00:00Z",
      familyRepresentatives: reps,
    };
  }

  const REPS = [
    ladderRep("anthropic.opus", 0.008), // 8.0×
    ladderRep("anthropic.sonnet", 0.004), // 4.0×
    ladderRep("anthropic.haiku", 0.001), // 1.0×
    ladderRep("openai.gpt5", 0.01), // 10×
    ladderRep("openai.mini", 0.002), // 2.0×
  ];

  const BASKET = [
    mp({ model: "opus", display_name: "Opus", provider: "anthropic", provider_name: "Anthropic", family: "anthropic.opus" }),
    mp({ model: "sonnet", display_name: "Sonnet", provider: "anthropic", provider_name: "Anthropic", family: "anthropic.sonnet" }),
    mp({ model: "haiku", display_name: "Haiku", provider: "anthropic", provider_name: "Anthropic", family: "anthropic.haiku" }),
    mp({ model: "gpt5", display_name: "GPT-5", provider: "openai", provider_name: "OpenAI", family: "openai.gpt5" }),
    mp({ model: "mini", display_name: "GPT-Mini", provider: "openai", provider_name: "OpenAI", family: "openai.mini" }),
  ];

  const OPUS = BASKET[0];

  // The per-row line whose display name (after the 4-space indent) matches.
  function rowFor(lines: string[], displayName: string): string | undefined {
    return lines.find((l) => l.startsWith(`    ${displayName} `) || l.trimStart().startsWith(displayName + " ") || l.trim() === displayName);
  }
  function idxOf(lines: string[], needle: string): number {
    return lines.findIndex((l) => l.includes(needle));
  }

  it("SHOULD open with the fixed × index ladder title verbatim", () => {
    const out = buildXIndexLadder({ scu: ladderScu(REPS), basket: BASKET, price: OPUS });
    assert.equal(
      out[0],
      "× index ladder (list price per unit of work · reference workload, not this session)",
    );
  });

  it("SHOULD anchor on the current model with its × index when the model is in-basket", () => {
    const out = buildXIndexLadder({ scu: ladderScu(REPS), basket: BASKET, price: OPUS });
    // Opus blended 0.008 / scuUsd 0.001 = 8.0×.
    assert.equal(out[1], "You're on Opus (8.0× index).");
  });

  it("SHOULD group rows under a 2-space provider header and lead with the current model's provider", () => {
    const out = buildXIndexLadder({ scu: ladderScu(REPS), basket: BASKET, price: OPUS });
    const anthropicHdr = idxOf(out, "  Anthropic");
    const openaiHdr = idxOf(out, "  OpenAI");
    assert.ok(anthropicHdr !== -1, "Anthropic provider header must render");
    assert.ok(openaiHdr !== -1, "OpenAI provider header must render");
    // Current model is Opus (Anthropic) → Anthropic leads even though OpenAI's flagship (10×) is higher.
    assert.ok(anthropicHdr < openaiHdr, "the current model's provider must lead the ladder");
    // Headers are exactly the provider name with a 2-space indent, no trailing content.
    assert.equal(out[anthropicHdr], "  Anthropic");
    assert.equal(out[openaiHdr], "  OpenAI");
  });

  it("SHOULD sort rows within a provider flagship-first (× index descending)", () => {
    const out = buildXIndexLadder({ scu: ladderScu(REPS), basket: BASKET, price: OPUS });
    // Anthropic: Opus 8 > Sonnet 4 > Haiku 1.
    assert.ok(idxOf(out, "Opus") < idxOf(out, "Sonnet"), "Opus (8×) before Sonnet (4×)");
    assert.ok(idxOf(out, "Sonnet") < idxOf(out, "Haiku"), "Sonnet (4×) before Haiku (1×)");
    // OpenAI: GPT-5 10 > GPT-Mini 2.
    assert.ok(idxOf(out, "GPT-5") < idxOf(out, "GPT-Mini"), "GPT-5 (10×) before GPT-Mini (2×)");
  });

  it("SHOULD tag the current model's own row with '← your model' and no cheaper/pricier factor", () => {
    const out = buildXIndexLadder({ scu: ladderScu(REPS), basket: BASKET, price: OPUS });
    const opusRow = rowFor(out, "Opus");
    assert.ok(opusRow, "Opus row must render");
    assert.ok(opusRow!.includes("← your model"), "current model is tagged '← your model'");
    assert.ok(!opusRow!.includes("cheaper") && !opusRow!.includes("pricier"), "no relative factor on the current row");
  });

  it("SHOULD tag an in-basket cheaper model with '~N× cheaper', one decimal below a 3× ratio", () => {
    const out = buildXIndexLadder({ scu: ladderScu(REPS), basket: BASKET, price: OPUS });
    // Sonnet 4× → cur/x = 8/4 = 2.0 (< 3) → one-decimal factor.
    const sonnetRow = rowFor(out, "Sonnet");
    assert.ok(sonnetRow, "Sonnet row must render");
    assert.ok(sonnetRow!.includes("~2.0× cheaper"), `expected '~2.0× cheaper', got: ${sonnetRow}`);
  });

  it("SHOULD tag an in-basket cheaper model with a whole-number factor at/above a 3× ratio", () => {
    const out = buildXIndexLadder({ scu: ladderScu(REPS), basket: BASKET, price: OPUS });
    // Haiku 1× → cur/x = 8/1 = 8 (>= 3) → integer factor, no decimal.
    const haikuRow = rowFor(out, "Haiku");
    assert.ok(haikuRow, "Haiku row must render");
    assert.ok(haikuRow!.includes("~8× cheaper"), `expected '~8× cheaper', got: ${haikuRow}`);
  });

  it("SHOULD tag an in-basket model pricier than the current one with 'pricier'", () => {
    const out = buildXIndexLadder({ scu: ladderScu(REPS), basket: BASKET, price: OPUS });
    // GPT-5 10× → cur/x = 8/10 = 0.8 (< 1) → pricier, with no cheaper factor.
    const gptRow = rowFor(out, "GPT-5");
    assert.ok(gptRow, "GPT-5 row must render");
    assert.ok(gptRow!.includes("pricier"), `expected 'pricier', got: ${gptRow}`);
    assert.ok(!gptRow!.includes("cheaper"), "a pricier model must not be tagged cheaper");
  });

  it("SHOULD tag an in-basket model within ±2% of the current × index as '≈ parity'", () => {
    // current = Opus 8×; add a peer family at 8.1× (8.1/8 = 1.0125, within 2%).
    const reps = [...REPS, ladderRep("anthropic.peer", 0.0081)]; // 8.1×
    const basket = [
      ...BASKET,
      mp({ model: "peer", display_name: "Peer", provider: "anthropic", provider_name: "Anthropic", family: "anthropic.peer" }),
    ];
    const out = buildXIndexLadder({ scu: ladderScu(reps), basket, price: OPUS });
    const peerRow = rowFor(out, "Peer");
    assert.ok(peerRow, "Peer row must render");
    assert.ok(peerRow!.includes("≈ parity"), `expected '≈ parity', got: ${peerRow}`);
  });

  it("SHOULD show the off-basket anchor and emit NO relative tag on any row when price is null", () => {
    const out = buildXIndexLadder({ scu: ladderScu(REPS), basket: BASKET, price: null });
    assert.equal(
      out[1],
      "Your model is off-basket — showing absolute × index (no comparison anchor).",
    );
    // No current model → no row may carry a comparison tag, and rows end after the × value (trailing ws trimmed).
    for (const l of out.slice(2)) {
      if (l.startsWith("  ") && !l.startsWith("    ")) continue; // provider header
      assert.ok(!l.includes("cheaper"), `off-basket row must not be tagged cheaper: ${l}`);
      assert.ok(!l.includes("pricier"), `off-basket row must not be tagged pricier: ${l}`);
      assert.ok(!l.includes("your model"), `off-basket row must not carry '← your model': ${l}`);
      assert.ok(!l.includes("parity"), `off-basket row must not be tagged parity: ${l}`);
      assert.equal(l, l.replace(/\s+$/, ""), `off-basket row must have trailing whitespace trimmed: ${JSON.stringify(l)}`);
    }
  });

  it("SHOULD fall back WITHOUT claiming off-basket when the current model is in-basket but absent from the SCU breakdown", () => {
    // Cross-endpoint reconstitution race: price is a real (non-null) model whose family is not among
    // the breakdown reps. There is no blended cost to anchor on, but the model is NOT off-basket.
    const orphanPrice = mp({
      model: "ghost",
      display_name: "Ghost",
      provider: "ghostco",
      provider_name: "GhostCo",
      family: "ghost.family",
    });
    const out = buildXIndexLadder({ scu: ladderScu(REPS), basket: BASKET, price: orphanPrice });
    assert.equal(
      out[1],
      "Your model isn't in the current SCU index — showing absolute × index (no comparison anchor).",
    );
    // No anchor resolved → no row may carry a relative tag.
    for (const l of out.slice(2)) {
      if (l.startsWith("  ") && !l.startsWith("    ")) continue; // provider header
      assert.ok(!l.includes("cheaper"), `row must not be tagged cheaper: ${l}`);
      assert.ok(!l.includes("pricier"), `row must not be tagged pricier: ${l}`);
      assert.ok(!l.includes("your model"), `row must not carry '← your model': ${l}`);
    }
  });

  it("SHOULD order providers purely by flagship × index descending when off-basket", () => {
    const out = buildXIndexLadder({ scu: ladderScu(REPS), basket: BASKET, price: null });
    // No current provider to promote → OpenAI flagship (10×) outranks Anthropic flagship (8×).
    assert.ok(idxOf(out, "  OpenAI") < idxOf(out, "  Anthropic"), "off-basket: highest-flagship provider leads");
  });

  it("SHOULD skip a representative whose family has no matching basket row", () => {
    const reps = [...REPS, ladderRep("ghost.family", 0.005)]; // 5× but absent from the basket
    const out = buildXIndexLadder({ scu: ladderScu(reps), basket: BASKET, price: OPUS });
    // The ghost family carries no display_name, so it must produce no row.
    assert.ok(!out.some((l) => l.includes("ghost.family")), "an unmatched representative must be skipped");
    assert.ok(!out.some((l) => l.includes("ghost.family-model")), "must not surface the modelKey either");
    // The five matched families still render (one row each).
    for (const name of ["Opus", "Sonnet", "Haiku", "GPT-5", "GPT-Mini"]) {
      assert.ok(rowFor(out, name), `${name} row must still render`);
    }
  });

  it("SHOULD return an empty array when no representative joins the basket", () => {
    const reps = [ladderRep("orphan.a", 0.003), ladderRep("orphan.b", 0.006)];
    const out = buildXIndexLadder({ scu: ladderScu(reps), basket: BASKET, price: null });
    assert.deepEqual(out, [], "zero joined rows → no ladder at all (not a bare title)");
  });
});

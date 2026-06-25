import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCanonicalIn, buildHistoryQueryString, _internals } from "./client.js";
import type { ModelPrice } from "./types.js";

const { parseFamilyRepresentatives } = _internals;

function mp(model: string): ModelPrice {
  return {
    model,
    display_name: model,
    provider: "test",
    provider_name: "Test",
    family: "test.family",
    integrated: true,
    released_at: null,
    input_usd_per_million: 1,
    output_usd_per_million: 1,
    input_wei_per_million: 1,
    output_wei_per_million: 1,
    cache: null,
  };
}

describe("resolveCanonicalIn", () => {
  const basket = [
    mp("claude-opus-4.7"),
    mp("claude-sonnet-4.5"),
    mp("gpt-5.4"),
    mp("gemini-3.1-pro"),
  ];

  it("returns null for null input", () => {
    assert.equal(resolveCanonicalIn(null, basket), null);
  });

  it("returns null for undefined input", () => {
    assert.equal(resolveCanonicalIn(undefined, basket), null);
  });

  it("returns exact match when model is in basket", () => {
    assert.equal(resolveCanonicalIn("claude-opus-4.7", basket), "claude-opus-4.7");
  });

  it("strips trailing bracket annotations", () => {
    assert.equal(
      resolveCanonicalIn("claude-opus-4.7[some-annotation]", basket),
      "claude-opus-4.7",
    );
  });

  it("strips trailing date suffixes (8+ digits)", () => {
    assert.equal(
      resolveCanonicalIn("claude-opus-4.7-20250501", basket),
      "claude-opus-4.7",
    );
  });

  it("normalizes digit-hyphen-digit to digit.digit", () => {
    assert.equal(resolveCanonicalIn("claude-opus-4-7", basket), "claude-opus-4.7");
  });

  it("normalizes gpt model with hyphen version", () => {
    assert.equal(resolveCanonicalIn("gpt-5-4", basket), "gpt-5.4");
  });

  it("falls back to closest version in same family", () => {
    // claude-opus-4.6 not in basket, but claude-opus-4.7 is
    assert.equal(resolveCanonicalIn("claude-opus-4.6", basket), "claude-opus-4.7");
  });

  it("picks closest version when multiple family members exist", () => {
    const multiBasket = [mp("claude-opus-4.5"), mp("claude-opus-4.7"), mp("claude-opus-5.0")];
    // 4.6 is closest to 4.5 (dist=0.1) and 4.7 (dist=0.1) — tie.
    // Implementation iterates Set, picks last-wins with <, so either is acceptable.
    const result = resolveCanonicalIn("claude-opus-4.6", multiBasket);
    assert.ok(
      result === "claude-opus-4.5" || result === "claude-opus-4.7",
      `Expected claude-opus-4.5 or claude-opus-4.7, got ${result}`,
    );
  });

  it("picks nearest when distances are unequal", () => {
    const multiBasket = [mp("claude-opus-4.5"), mp("claude-opus-5.0")];
    // 4.8 → dist to 4.5 = 0.3, dist to 5.0 = 0.2 → picks 5.0
    assert.equal(resolveCanonicalIn("claude-opus-4.8", multiBasket), "claude-opus-5.0");
  });

  // --- family fallback via dot normalization + family ---

  it("applies dot normalization before family fallback", () => {
    // claude-opus-4-6 → dot-normalized to claude-opus-4.6 → family fallback → 4.7
    assert.equal(resolveCanonicalIn("claude-opus-4-6", basket), "claude-opus-4.7");
  });

  it("returns null when no family matches", () => {
    assert.equal(resolveCanonicalIn("llama-4-maverick", basket), null);
  });

  it("returns null for completely unrelated model name", () => {
    assert.equal(resolveCanonicalIn("deepseek-r2", basket), null);
  });

  it("returns null with empty basket", () => {
    assert.equal(resolveCanonicalIn("claude-opus-4.7", []), null);
  });
});

// Trust boundary for /v1/oracle/scu.breakdown — malformed rows must be dropped, not carried through as NaN-producing partials.
describe("parseFamilyRepresentatives", () => {
  const validRep = {
    family: "anthropic.claude-opus",
    modelKey: "claude-opus-4.7",
    inputPriceUsdPerMillion: 15,
    outputPriceUsdPerMillion: 75,
    blendedCostUsd: 0.0175,
  };

  it("SHOULD map a well-formed breakdown into typed representatives", () => {
    const out = parseFamilyRepresentatives({ familyRepresentatives: [validRep] });
    assert.deepEqual(out, [validRep]);
  });

  it("SHOULD return [] when the breakdown is null", () => {
    assert.deepEqual(parseFamilyRepresentatives(null), []);
  });

  it("SHOULD return [] when the breakdown is not an object", () => {
    assert.deepEqual(parseFamilyRepresentatives("not-an-object"), []);
    assert.deepEqual(parseFamilyRepresentatives(42), []);
  });

  it("SHOULD return [] when familyRepresentatives is missing", () => {
    assert.deepEqual(parseFamilyRepresentatives({}), []);
  });

  it("SHOULD return [] when familyRepresentatives is not an array", () => {
    assert.deepEqual(parseFamilyRepresentatives({ familyRepresentatives: {} }), []);
  });

  it("SHOULD drop a row whose blendedCostUsd is missing — would otherwise produce NaN× index", () => {
    const broken = { ...validRep, blendedCostUsd: undefined };
    const out = parseFamilyRepresentatives({ familyRepresentatives: [validRep, broken] });
    assert.deepEqual(out, [validRep]);
  });

  it("SHOULD drop a row whose numeric field arrived as a string", () => {
    const broken = { ...validRep, inputPriceUsdPerMillion: "15" };
    const out = parseFamilyRepresentatives({ familyRepresentatives: [broken] });
    assert.deepEqual(out, []);
  });

  it("SHOULD drop a row whose family is missing", () => {
    const broken = { ...validRep, family: undefined };
    const out = parseFamilyRepresentatives({ familyRepresentatives: [broken] });
    assert.deepEqual(out, []);
  });

  it("SHOULD drop null / non-object array entries without throwing", () => {
    const out = parseFamilyRepresentatives({
      familyRepresentatives: [null, "x", 7, validRep],
    });
    assert.deepEqual(out, [validRep]);
  });
});

describe("buildHistoryQueryString", () => {
  it("returns an empty string when no query params are set", () => {
    assert.equal(buildHistoryQueryString({}), "");
  });

  it("emits only the keys that are present — undefined keys are not serialised", () => {
    assert.equal(buildHistoryQueryString({ granularity: "daily" }), "?granularity=daily");
  });

  it("preserves the order from from → to → granularity → limit", () => {
    assert.equal(
      buildHistoryQueryString({
        from: "2026-04-01T00:00:00Z",
        to: "2026-06-01T00:00:00Z",
        granularity: "weekly",
        limit: 50,
      }),
      "?from=2026-04-01T00%3A00%3A00Z&to=2026-06-01T00%3A00%3A00Z&granularity=weekly&limit=50",
    );
  });

  it("serialises limit=0 (numeric) — must not be silently dropped as a falsy value", () => {
    assert.equal(buildHistoryQueryString({ limit: 0 }), "?limit=0");
  });
});

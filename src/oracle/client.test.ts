import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHistoryQueryString, _internals } from "./client.js";

const { parseFamilyRepresentatives } = _internals;

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

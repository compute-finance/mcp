import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHistoryQueryString, _internals } from "./client.js";
import type { OraclePriceComponentWire } from "./types.js";

const { adaptComponent, adaptCache, adaptReasoning, parseFamilyRepresentatives } =
  _internals;

function wireComponent(
  over: Partial<OraclePriceComponentWire> = {},
): OraclePriceComponentWire {
  return {
    usdPerMillion: 0.5,
    ratioOfInput: 0.1,
    provenance: "verified",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function captureStderr(): { text: () => string; restore: () => void } {
  const original = process.stderr.write;
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

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

describe("adaptComponent — boundary normalization", () => {
  it("SHOULD return null IF raw component is null", () => {
    assert.equal(adaptComponent("m", "cachedInput", 5, null), null);
  });

  it("SHOULD return null IF raw component is undefined", () => {
    assert.equal(adaptComponent("m", "cachedInput", 5, undefined), null);
  });

  it("SHOULD derive ratioOfInput from usdPerMillion when ratio is null", () => {
    const out = adaptComponent(
      "m",
      "cachedInput",
      5,
      wireComponent({ usdPerMillion: 0.5, ratioOfInput: null }),
    );
    assert.ok(out);
    assert.equal(out.usdPerMillion, 0.5);
    assert.equal(out.ratioOfInput, 0.1);
  });

  it("SHOULD derive usdPerMillion from ratioOfInput when usd is null", () => {
    const out = adaptComponent(
      "m",
      "cachedInput",
      5,
      wireComponent({ usdPerMillion: null, ratioOfInput: 0.2 }),
    );
    assert.ok(out);
    assert.equal(out.usdPerMillion, 1);
    assert.equal(out.ratioOfInput, 0.2);
  });

  it("SHOULD throw IF both usdPerMillion and ratioOfInput are null", () => {
    assert.throws(() =>
      adaptComponent(
        "model-x",
        "cachedInput",
        5,
        wireComponent({ usdPerMillion: null, ratioOfInput: null }),
      ),
    );
  });

  it("SHOULD throw IF only usd is given and inputUsdPerMillion is 0 (cannot derive ratio)", () => {
    assert.throws(() =>
      adaptComponent(
        "model-x",
        "cachedInput",
        0,
        wireComponent({ usdPerMillion: 1.5, ratioOfInput: null }),
      ),
    );
  });

  it("SHOULD preserve both values when both present", () => {
    const out = adaptComponent("m", "cachedInput", 5, wireComponent());
    assert.ok(out);
    assert.equal(out.usdPerMillion, 0.5);
    assert.equal(out.ratioOfInput, 0.1);
  });

  it("SHOULD carry the provenance mark THROUGH a derived value — Bug guarded: a price whose usd was computed from a ratio must keep the mark the oracle put on it", () => {
    const out = adaptComponent(
      "m",
      "cachedInput",
      5,
      wireComponent({ usdPerMillion: null, ratioOfInput: 0.2, provenance: "promotional" }),
    );
    assert.ok(out);
    assert.equal(out.provenance, "promotional");
  });

  it("SHOULD keep a null createdAt as null", () => {
    const out = adaptComponent("m", "cachedInput", 5, wireComponent({ createdAt: null }));
    assert.ok(out);
    assert.equal(out.createdAt, null);
  });
});

describe("adaptCache — block-level", () => {
  it("SHOULD return null when block is null", () => {
    assert.equal(adaptCache("m", 5, null), null);
  });

  it("SHOULD return null when block is undefined", () => {
    assert.equal(adaptCache("m", 5, undefined), null);
  });

  it("SHOULD pass through per-component nulls verbatim", () => {
    const out = adaptCache("m", 5, {
      cachedInput: wireComponent(),
      cacheWrite5m: null,
      cacheWrite1h: null,
    });
    assert.ok(out);
    assert.ok(out.cachedInput);
    assert.equal(out.cacheWrite5m, null);
    assert.equal(out.cacheWrite1h, null);
  });

  it("SHOULD throw IF a component is unusable — Bug guarded: cache prices feed effective cost, so a corrupt row must fail loudly instead of understating a bill", () => {
    assert.throws(() =>
      adaptCache("m", 5, {
        cachedInput: wireComponent({ usdPerMillion: null, ratioOfInput: null }),
        cacheWrite5m: null,
        cacheWrite1h: null,
      }),
    );
  });
});

describe("adaptReasoning — block-level", () => {
  it("SHOULD return null when the model has no reasoning price", () => {
    assert.equal(adaptReasoning("m", 5, null), null);
    assert.equal(adaptReasoning("m", 5, undefined), null);
  });

  it("SHOULD degrade to no reasoning price AND warn IF the component is unusable — Bug guarded: reasoning is reference data no cost is built from, so a corrupt row must not sink the whole response the way a corrupt cache row does", () => {
    const stderr = captureStderr();
    let out;
    try {
      out = adaptReasoning("reasoning-drift-model", 5, {
        reasoningOutput: wireComponent({ usdPerMillion: null, ratioOfInput: null }),
      });
    } finally {
      stderr.restore();
    }
    assert.equal(out, null);
    assert.match(stderr.text(), /reasoning-drift-model/);
  });
});

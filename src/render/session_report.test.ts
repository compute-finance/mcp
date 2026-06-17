import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _internals } from "./session_report.js";
import type { ModelPrice } from "../oracle/types.js";

const { pickCheapestByFamily } = _internals;

function mp(overrides: Partial<ModelPrice> & Pick<ModelPrice, "model" | "family">): ModelPrice {
  return {
    model: overrides.model,
    display_name: overrides.model,
    provider: "test",
    provider_name: "Test",
    family: overrides.family,
    integrated: true,
    released_at: null,
    input_usd_per_million: 0,
    output_usd_per_million: 0,
    input_wei_per_million: 0,
    output_wei_per_million: 0,
    cache: null,
    ...overrides,
  };
}

describe("pickCheapestByFamily", () => {
  it("SHOULD pick the cheapest representative per family", () => {
    const out = pickCheapestByFamily([
      mp({ model: "gpt-cheap", family: "openai.gpt", input_usd_per_million: 1, output_usd_per_million: 1 }),
      mp({ model: "gpt-pricy", family: "openai.gpt", input_usd_per_million: 5, output_usd_per_million: 5 }),
      mp({ model: "claude-cheap", family: "anthropic.claude", input_usd_per_million: 2, output_usd_per_million: 2 }),
    ]);
    const models = out.map((p) => p.model);
    assert.ok(models.includes("gpt-cheap"));
    assert.ok(!models.includes("gpt-pricy"));
    assert.ok(models.includes("claude-cheap"));
    assert.equal(out.length, 2);
  });

  it("SHOULD return results sorted ascending by input+output sum", () => {
    const out = pickCheapestByFamily([
      mp({ model: "expensive", family: "f.b", input_usd_per_million: 10, output_usd_per_million: 10 }),
      mp({ model: "cheap", family: "f.a", input_usd_per_million: 1, output_usd_per_million: 1 }),
      mp({ model: "mid", family: "f.c", input_usd_per_million: 5, output_usd_per_million: 5 }),
    ]);
    assert.deepEqual(out.map((p) => p.model), ["cheap", "mid", "expensive"]);
  });

  it("SHOULD fall back to provider+model key IF family is empty — Bug guarded: a missing family must not collapse every empty-family model into one bucket", () => {
    const out = pickCheapestByFamily([
      mp({ model: "a", family: "", provider: "p1", input_usd_per_million: 1, output_usd_per_million: 1 }),
      mp({ model: "b", family: "", provider: "p1", input_usd_per_million: 2, output_usd_per_million: 2 }),
      mp({ model: "c", family: "", provider: "p2", input_usd_per_million: 3, output_usd_per_million: 3 }),
    ]);
    assert.equal(out.length, 3, "every empty-family row must stand on its own, not deduplicate silently");
  });
});

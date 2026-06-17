import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolDefinitions } from "./definitions.js";

describe("toolDefinitions", () => {
  const names = toolDefinitions.map((t) => t.name);

  it("SHOULD NOT include data_get_tiers — Bug guarded: the upstream /v1/oracle/tiers endpoint is gone", () => {
    assert.ok(!names.includes("data_get_tiers"));
  });

  it("SHOULD NOT carry CPI tier wording in any tool description — Bug guarded: stale tier prose would steer the model towards a non-existent field", () => {
    const offenders = toolDefinitions.filter(
      (t) =>
        /\btier\b/i.test(t.description) ||
        /by[\s_-]?tier/i.test(t.description) ||
        /frontier_underused/.test(t.description) ||
        /\bfrontier\b.*\bstandard\b.*\blightweight\b/i.test(t.description),
    );
    assert.deepEqual(
      offenders.map((t) => t.name),
      [],
      `tier wording in: ${offenders.map((t) => t.name).join(", ")}`,
    );
  });

  it("SHOULD describe data_get_basket with the family field — Bug guarded: family is the load-bearing categorical key after CF-418", () => {
    const basket = toolDefinitions.find((t) => t.name === "data_get_basket");
    assert.ok(basket);
    assert.ok(basket.description.includes("family"));
  });

  it("SHOULD describe compute_compare with by_family grouping", () => {
    const compare = toolDefinitions.find((t) => t.name === "compute_compare");
    assert.ok(compare);
    assert.ok(compare.description.includes("family"));
  });

  it("SHOULD include data_get_breakdown — Bug guarded: the typed extraction over /scu.breakdown must stay first-class", () => {
    assert.ok(names.includes("data_get_breakdown"));
    const breakdown = toolDefinitions.find((t) => t.name === "data_get_breakdown");
    assert.ok(breakdown);
    assert.ok(breakdown.description.includes("breakdown"));
    assert.ok(breakdown.description.includes("methodologyVersion"));
    assert.ok(breakdown.description.includes("family"));
  });

  it("SHOULD have unique tool names — Bug guarded: a duplicate would mask one definition with another at dispatch", () => {
    const seen = new Set<string>();
    for (const name of names) {
      assert.ok(!seen.has(name), `duplicate tool name: ${name}`);
      seen.add(name);
    }
  });
});

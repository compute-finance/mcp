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

  it("SHOULD include data_get_history and data_get_model_price_history as ORACLE-annotated read tools", () => {
    for (const name of ["data_get_history", "data_get_model_price_history"]) {
      const tool = toolDefinitions.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.idempotentHint, true);
    }
  });

  it("SHOULD describe data_get_history with the granularity and CSV-free wire — Bug guarded: agents must learn the granularity vocabulary before sending requests", () => {
    const tool = toolDefinitions.find((t) => t.name === "data_get_history");
    assert.ok(tool);
    assert.ok(tool.description.includes("per-revision"));
    assert.ok(tool.description.includes("daily"));
    assert.ok(tool.description.includes("weekly"));
    assert.ok(tool.description.includes("scuUsd"));
  });

  it("SHOULD describe data_get_model_price_history with the model requirement and unavailableRevisions surface", () => {
    const tool = toolDefinitions.find((t) => t.name === "data_get_model_price_history");
    assert.ok(tool);
    assert.ok(tool.description.includes("unavailableRevisions"));
    assert.ok(tool.description.includes("input/output"));
  });

  it("SHOULD include data_get_catalog and data_get_model_price_at as ORACLE-annotated read tools", () => {
    for (const name of ["data_get_catalog", "data_get_model_price_at"]) {
      const tool = toolDefinitions.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.idempotentHint, true);
    }
  });

  it("SHOULD describe data_get_catalog with the indexMember and integrated flags — Bug guarded: agents must distinguish catalog-only from basket entries", () => {
    const tool = toolDefinitions.find((t) => t.name === "data_get_catalog");
    assert.ok(tool);
    assert.ok(tool.description.includes("indexMember"));
    assert.ok(tool.description.includes("integrated"));
    assert.ok(tool.description.includes("pricing-only"));
  });

  it("SHOULD describe data_get_model_price_at with the discriminated source union — Bug guarded: agents must route on manifest vs providerCost source", () => {
    const tool = toolDefinitions.find((t) => t.name === "data_get_model_price_at");
    assert.ok(tool);
    assert.ok(tool.description.includes("manifest"));
    assert.ok(tool.description.includes("providerCost"));
    assert.ok(tool.description.includes("source"));
  });

  it("SHOULD include data_get_baseline as an ORACLE-annotated read tool", () => {
    const tool = toolDefinitions.find((t) => t.name === "data_get_baseline");
    assert.ok(tool, "data_get_baseline missing");
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.idempotentHint, true);
  });

  it("SHOULD describe data_get_baseline with the set-once invariant and computeIndex formula — Bug guarded: agents must understand baseline is frozen, never recomputed", () => {
    const tool = toolDefinitions.find((t) => t.name === "data_get_baseline");
    assert.ok(tool);
    assert.ok(tool.description.includes("set-once"));
    assert.ok(tool.description.includes("computeIndex"));
    assert.ok(tool.description.includes("first confirmed revision"));
    assert.ok(
      tool.description.includes("(baseline.scuUsd / point.scuUsd) × 100") ||
        tool.description.includes("baseline / point.scuUsd"),
    );
  });

  it("SHOULD include data_get_scu_at as an ORACLE-annotated read tool", () => {
    const tool = toolDefinitions.find((t) => t.name === "data_get_scu_at");
    assert.ok(tool, "data_get_scu_at missing");
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.idempotentHint, true);
  });

  it("SHOULD describe data_get_scu_at with the step-function and tie-break semantics — Bug guarded: agents must not interpolate or pick the wrong revision on equal publishedAt", () => {
    const tool = toolDefinitions.find((t) => t.name === "data_get_scu_at");
    assert.ok(tool);
    assert.ok(tool.description.includes("step function"));
    assert.ok(tool.description.includes("publishedAt"));
    assert.ok(tool.description.includes("highest revisionVersion"));
    assert.ok(tool.description.includes("methodologyVersion"));
    assert.ok(tool.description.includes("metadataHash"));
  });
});

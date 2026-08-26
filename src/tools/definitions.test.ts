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

  it("SHOULD describe data_get_basket with the family field — Bug guarded: family is the load-bearing categorical key for grouping and joins", () => {
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

  it("SHOULD describe data_get_catalog with the indexMember flag — Bug guarded: agents must distinguish family representatives from other members", () => {
    const tool = toolDefinitions.find((t) => t.name === "data_get_catalog");
    assert.ok(tool);
    assert.ok(tool.description.includes("indexMember"));
  });

  it("SHOULD teach all three provenance marks AND that the mark never moves the amount charged ON every price-bearing tool — Bug guarded: an agent told a price is 'inferred' without the invariant discounts a number that bills in full", () => {
    for (const name of [
      "data_get_basket",
      "data_get_price",
      "data_get_catalog",
      "compute_estimate",
    ]) {
      const tool = toolDefinitions.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      for (const mark of ["verified", "inferred", "promotional"]) {
        assert.ok(tool.description.includes(`'${mark}'`), `${name} omits '${mark}'`);
      }
      assert.ok(
        tool.description.includes("bills exactly as shown"),
        `${name} omits the bills-as-shown invariant`,
      );
      assert.ok(
        tool.description.includes("not the amount charged"),
        `${name} omits that the mark rates trust, not cost`,
      );
    }
  });

  it("SHOULD name the reasoning block ON the tools that return it", () => {
    for (const name of ["data_get_basket", "data_get_price", "data_get_catalog"]) {
      const tool = toolDefinitions.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      assert.ok(tool.description.includes("reasoning"), `${name} omits the reasoning block`);
    }
  });

  it("SHOULD NOT offer a separate reasoning cost leg ON compute_estimate — Bug guarded: reasoning tokens already sit inside output_tokens and a second leg doubles the estimate", () => {
    const tool = toolDefinitions.find((t) => t.name === "compute_estimate");
    assert.ok(tool);
    assert.ok(tool.description.includes("no separate reasoning leg"));
  });

  it("SHOULD describe data_get_model_price_at with the discriminated source union — Bug guarded: agents must route on the 'manifest' vs 'catalog' source the oracle actually publishes", () => {
    const tool = toolDefinitions.find((t) => t.name === "data_get_model_price_at");
    assert.ok(tool);
    assert.ok(tool.description.includes("'manifest'"));
    assert.ok(tool.description.includes("'catalog'"));
    assert.ok(tool.description.includes("source"));
    assert.ok(!tool.description.includes("providerCost"));
  });

  it("SHOULD describe manifestKey alongside modelKey on both per-model price tools — Bug guarded: the bare manifest key and the canonical id are distinct fields and must not be conflated", () => {
    for (const name of ["data_get_model_price_at", "data_get_model_price_history"]) {
      const tool = toolDefinitions.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      assert.ok(tool.description.includes("manifestKey"), `${name} omits manifestKey`);
      assert.ok(tool.description.includes("modelKey"), `${name} omits modelKey`);
    }
  });

  it("SHOULD NOT claim data_get_model_price_history needs a confirmed basket appearance — Bug guarded: the oracle serves any tracked model and the stale precondition steers agents away from catalog-only models", () => {
    const tool = toolDefinitions.find((t) => t.name === "data_get_model_price_history");
    assert.ok(tool);
    assert.ok(!/never appeared/i.test(tool.description));
    assert.ok(!/appeared in at least one/i.test(tool.description));
  });

  it("SHOULD teach the canonical vendor-prefixed id AND the bare fallback ON every tool taking a model — Bug guarded: an agent handed a bare-only example never learns the id the oracle echoes back", () => {
    const modelTools = toolDefinitions.filter(
      (t) =>
        "model" in
        ((t.inputSchema.properties ?? {}) as Record<string, unknown>),
    );
    assert.deepEqual(
      modelTools.map((t) => t.name),
      [
        "data_get_price",
        "data_get_model_price_history",
        "data_get_model_price_at",
        "compute_estimate",
      ],
    );
    for (const tool of modelTools) {
      const props = tool.inputSchema.properties as Record<
        string,
        { examples?: string[] }
      >;
      for (const example of props.model.examples ?? []) {
        assert.ok(example.includes("/"), `${tool.name} example '${example}' is not canonical`);
      }
      assert.ok(
        /canonical vendor-prefixed id/.test(tool.description),
        `${tool.name} does not name the canonical form`,
      );
      assert.ok(
        /bare name/.test(tool.description),
        `${tool.name} does not say the bare name still resolves`,
      );
    }
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

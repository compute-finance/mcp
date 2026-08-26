import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolDefinitions } from "./definitions.js";

describe("toolDefinitions", () => {
  const names = toolDefinitions.map((t) => t.name);

  it("SHOULD NOT include data_get_tiers — Bug guarded: the upstream /v1/oracle/tiers endpoint is gone", () => {
    assert.ok(!names.includes("data_get_tiers"));
  });

  it("SHOULD NOT carry CPI quality-tier wording in any tool description — Bug guarded: stale quality-tier prose would steer the model towards a non-existent field, while the context-price ladder is a live concept and must stay documented", () => {
    const offenders = toolDefinitions.filter((t) => {
      const withoutContextTiers = t.description.replace(/context[\s_-]?tiers?/gi, "");
      return (
        /\btiers?\b/i.test(withoutContextTiers) ||
        /by[\s_-]?tier/i.test(withoutContextTiers) ||
        /frontier_underused/.test(t.description) ||
        /\bfrontier\b.*\bstandard\b.*\blightweight\b/i.test(t.description)
      );
    });
    assert.deepEqual(
      offenders.map((t) => t.name),
      [],
      `quality-tier wording in: ${offenders.map((t) => t.name).join(", ")}`,
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

  it("SHOULD teach the uniform ladder AND the half-open selection rule ON every long-context-aware tool — Bug guarded: an agent that branches on a missing ladder, or reads the ranges as open, quotes the wrong rate at a threshold", () => {
    for (const name of [
      "data_get_basket",
      "data_get_price",
      "compute_estimate",
      "compute_compare",
    ]) {
      const tool = toolDefinitions.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      assert.ok(
        tool.description.includes("always has at least one rung"),
        `${name} omits that a flat model still ships a ladder`,
      );
      assert.ok(
        tool.description.includes("half-open"),
        `${name} omits the half-open range rule`,
      );
      assert.ok(
        tool.description.includes("cache reads plus cache writes"),
        `${name} omits that the whole input side selects the rung`,
      );
      assert.ok(
        tool.description.includes("max_input_tokens"),
        `${name} omits max_input_tokens`,
      );
    }
  });

  it("SHOULD name context_tiers only ON the tools that return it — Bug guarded: a compute tool advertising the whole ladder sends an agent looking for a field that is not in its response", () => {
    const carriers = toolDefinitions
      .filter((t) => /`context_tiers` carries/.test(t.description))
      .map((t) => t.name);
    assert.deepEqual(carriers, ["data_get_basket", "data_get_price"]);
  });

  it("SHOULD name the rung a cost was quoted at ON both compute tools — Bug guarded: a long-context cost without its rung cannot be reconciled against the bill", () => {
    for (const name of ["compute_estimate", "compute_compare"]) {
      const tool = toolDefinitions.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      assert.ok(
        tool.description.includes("applied_context_tier"),
        `${name} omits applied_context_tier`,
      );
      assert.ok(
        tool.description.includes("exceeds_max_input_tokens"),
        `${name} omits exceeds_max_input_tokens`,
      );
    }
  });

  it("SHOULD say compute_estimate still quotes a cost above max_input_tokens — Bug guarded: an agent told only that the request is refused stops reading the number it asked for", () => {
    const tool = toolDefinitions.find((t) => t.name === "compute_estimate");
    assert.ok(tool);
    assert.ok(tool.description.includes("still quoted"));
    assert.ok(tool.description.includes("would be rejected"));
  });

  it("SHOULD describe data_get_catalog with the upstream long-context shape — Bug guarded: this tool passes the oracle document through, so an agent must learn that contextTiers is absent rather than empty on a flat model", () => {
    const tool = toolDefinitions.find((t) => t.name === "data_get_catalog");
    assert.ok(tool);
    assert.ok(tool.description.includes("contextTiers"));
    assert.ok(tool.description.includes("maxInputTokens"));
    assert.ok(/absent/i.test(tool.description));
  });

  it("SHOULD spell out ON both compute tools that input_tokens is the whole input side — Bug guarded: an agent passing prompt tokens alone lands a rung too low, which is exactly the number the ladder exists to prevent", () => {
    for (const name of ["compute_estimate", "compute_compare"]) {
      const tool = toolDefinitions.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      const props = tool.inputSchema.properties as Record<
        string,
        { description?: string }
      >;
      const described = props.input_tokens.description ?? "";
      assert.match(described, /prompt plus cache reads plus cache writes/);
      assert.match(described, /rung/);
      assert.ok(
        tool.description.includes("charged at the full input rate"),
        `${name} disagrees with its own parameter on how cache tokens are priced`,
      );
    }
  });

  it("SHOULD say the ladder reads null rather than flat ON the two data tools — Bug guarded: a one-rung ladder standing in for an unread one is an unknown price served as a complete one", () => {
    for (const name of ["data_get_basket", "data_get_price"]) {
      const tool = toolDefinitions.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      assert.ok(
        tool.description.includes("never a one-rung ladder"),
        `${name} omits what an unreadable catalogue does to the ladder`,
      );
    }
  });

  it("SHOULD say both compute tools error rather than quote WHEN the catalogue cannot be read — Bug guarded: falling back to the flat rate understates a long context without saying so", () => {
    for (const name of ["compute_estimate", "compute_compare"]) {
      const tool = toolDefinitions.find((t) => t.name === name);
      assert.ok(tool, `${name} missing`);
      assert.ok(
        tool.description.includes("errors this tool instead of quoting"),
        `${name} omits that an unreadable catalogue refuses the quote`,
      );
    }
  });

  it("SHOULD say the session counterfactual stays on the base rate — Bug guarded: a rung is picked per request, so pricing a session's summed input on one would overcharge", () => {
    const tool = toolDefinitions.find((t) => t.name === "analyze_session");
    assert.ok(tool);
    assert.ok(tool.description.includes("never a long-context rung"));
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

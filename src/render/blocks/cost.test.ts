import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CostBlockInput, renderCostBlock } from "./cost.js";

function costInput(overrides: Partial<CostBlockInput> = {}): CostBlockInput {
  return {
    effective_usd: 66.49,
    nominal_usd: 316.14,
    cache_note: "Oracle cache multipliers: read 0.1× · write-5m 1.25× · write-1h 2×",
    cache_pricing_missing: null,
    ...overrides,
  };
}

describe("renderCostBlock", () => {
  it("SHOULD render header, effective, nominal, saved, and cache note WHEN cost is fully known", () => {
    const out = renderCostBlock(costInput());
    assert.equal(out[0], "Cost (this session):");
    assert.ok(out.some((l) => l.includes("Effective (cache-aware):  $66.49")));
    assert.ok(out.some((l) => l.includes("Nominal (no cache):       $316.14")));
    assert.ok(out.some((l) => l.includes("Saved by caching:")));
    assert.ok(out.some((l) => l.includes("Oracle cache multipliers")));
  });

  it("SHOULD append (−X%) suffix to Saved by caching — Bug guarded: percentage must equal saved divided by nominal", () => {
    const out = renderCostBlock(costInput());
    const savedLine = out.find((l) => l.includes("Saved by caching:"))!;
    assert.match(savedLine, /\(−79%\)/);
  });

  it("SHOULD drop cache note WHEN it is empty", () => {
    const out = renderCostBlock(costInput({ cache_note: "" }));
    assert.equal(
      out.some((l) => l.includes("multipliers")),
      false,
    );
  });

  it("SHOULD omit the percentage suffix WHEN nominal is zero", () => {
    const out = renderCostBlock(
      costInput({ effective_usd: 0, nominal_usd: 0 }),
    );
    const savedLine = out.find((l) => l.includes("Saved by caching:"))!;
    assert.equal(savedLine.includes("%"), false);
    assert.equal(savedLine.includes("NaN"), false);
  });

  it("SHOULD omit the percentage suffix WHEN effective exceeds nominal — Bug guarded: a negative saving must not render as '(−-X%)'", () => {
    const out = renderCostBlock(
      costInput({ effective_usd: 15, nominal_usd: 10 }),
    );
    const savedLine = out.find((l) => l.includes("Saved by caching:"))!;
    assert.equal(savedLine.includes("%"), false);
    assert.equal(savedLine.includes("−-"), false);
  });

  it("SHOULD omit the percentage suffix WHEN savings round to zero", () => {
    const out = renderCostBlock(
      costInput({ effective_usd: 100, nominal_usd: 100.1 }),
    );
    const savedLine = out.find((l) => l.includes("Saved by caching:"))!;
    assert.equal(savedLine.includes("%"), false);
  });

  it("SHOULD render the cache-pricing-missing fallback WHEN effective is null but nominal is known", () => {
    const out = renderCostBlock(
      costInput({
        effective_usd: null,
        cache_pricing_missing: { model: "test-model", missing: "cachedInput" },
      }),
    );
    assert.ok(out.some((l) => l.includes("Nominal (no cache discount):")));
    assert.ok(
      out.some((l) => l.includes("unavailable") && l.includes("test-model")),
    );
  });

  it("SHOULD render the off-basket fallback WHEN nothing is available", () => {
    const out = renderCostBlock(
      costInput({ effective_usd: null, nominal_usd: null }),
    );
    assert.equal(out.length, 2);
    assert.ok(out[1].includes("not tracked by oracle"));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CostBlockInput,
  HistoryBlockInput,
  OverheadBlockInput,
  renderCostBlock,
  renderHistoryBlock,
  renderOverheadBlock,
} from "./blocks.js";
import { HistoryStats } from "../storage/history.js";

function costInput(overrides: Partial<CostBlockInput> = {}): CostBlockInput {
  return {
    effective_usd: 66.49,
    nominal_usd: 316.14,
    cache_note: "Oracle cache multipliers: read 0.1× · write-5m 1.25× · write-1h 2×",
    cache_pricing_missing: null,
    ...overrides,
  };
}

function statsAt(
  sample_size: number,
  overrides: Partial<HistoryStats> = {},
): HistoryStats {
  return {
    sample_size,
    distinct_sessions: sample_size,
    by_profile: {
      mixed: {
        n: sample_size,
        median_total_input: 100_000,
        median_output: 5000,
        median_effective_usd: 24,
      },
    },
    cumulative_effective_usd: 100,
    cumulative_nominal_usd: 500,
    insights: [],
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

function overheadInput(
  overrides: Partial<OverheadBlockInput> = {},
): OverheadBlockInput {
  return {
    fixed_overhead_tokens: 30_000,
    inferences: 115,
    scu_usd: 0.0024,
    cached_input_usd_per_million: 0.3,
    ...overrides,
  };
}

describe("renderOverheadBlock", () => {
  it("SHOULD render header and overhead line WHEN inputs are valid", () => {
    const out = renderOverheadBlock(overheadInput());
    assert.equal(out.length, 2);
    assert.match(out[0], /Context overhead — paid every inference \(×115/);
    assert.match(out[1], /^ {2}fixed overhead/);
  });

  it("SHOULD return an empty array WHEN inferences is under 2 — Bug guarded: a single-turn session has no re-read multiplier", () => {
    assert.deepEqual(renderOverheadBlock(overheadInput({ inferences: 0 })), []);
    assert.deepEqual(renderOverheadBlock(overheadInput({ inferences: 1 })), []);
  });

  it("SHOULD return an empty array WHEN there is no cache write on the first inference", () => {
    assert.deepEqual(
      renderOverheadBlock(overheadInput({ fixed_overhead_tokens: 0 })),
      [],
    );
  });

  it("SHOULD return an empty array WHEN SCU price is missing or invalid", () => {
    assert.deepEqual(renderOverheadBlock(overheadInput({ scu_usd: 0 })), []);
    assert.deepEqual(renderOverheadBlock(overheadInput({ scu_usd: -0.001 })), []);
  });

  it("SHOULD return an empty array WHEN cached input price is missing", () => {
    assert.deepEqual(
      renderOverheadBlock(overheadInput({ cached_input_usd_per_million: 0 })),
      [],
    );
  });

  it("SHOULD reconcile per-turn × inferences against the displayed total — Bug guarded: drift between the two figures breaks the AC", () => {
    const inputs = overheadInput({
      fixed_overhead_tokens: 30_000,
      inferences: 100,
      scu_usd: 0.001,
      cached_input_usd_per_million: 0.3,
    });
    const out = renderOverheadBlock(inputs);
    const line = out[1];
    const perTurn = Number(
      line.match(/([\d.,]+) SCU\/turn/)![1].replace(/,/g, ""),
    );
    const totalMatch = line.match(/= ([\d.]+)([kM]?) SCU/);
    const totalRaw = Number(totalMatch![1]);
    const totalScu =
      totalRaw *
      (totalMatch![2] === "M" ? 1_000_000 : totalMatch![2] === "k" ? 1_000 : 1);
    assert.ok(Math.abs(perTurn * 100 - totalScu) / totalScu < 0.05);
  });

  it("SHOULD render per-turn with one decimal WHEN below 10 SCU — Bug guarded: integer rounding for tiny per-turn values made per_turn × N visibly diverge from the displayed total", () => {
    const out = renderOverheadBlock(
      overheadInput({
        fixed_overhead_tokens: 23_000,
        inferences: 383,
        scu_usd: 0.0024,
        cached_input_usd_per_million: 0.5,
      }),
    );
    assert.match(out[1], /\d\.\d SCU\/turn/);
  });

  it("SHOULD render per-turn as a comma-separated integer WHEN above 10 SCU", () => {
    const out = renderOverheadBlock(
      overheadInput({
        fixed_overhead_tokens: 5_000_000,
        inferences: 115,
        scu_usd: 0.0024,
        cached_input_usd_per_million: 0.5,
      }),
    );
    assert.match(out[1], /\d,\d{3} SCU\/turn/);
  });

  it("SHOULD never emit NaN/Infinity FOR adversarial inputs", () => {
    const out = renderOverheadBlock(
      overheadInput({
        fixed_overhead_tokens: 1_000_000_000,
        inferences: 9_999,
        scu_usd: 0.0001,
        cached_input_usd_per_million: 100,
      }),
    );
    for (const bad of ["NaN", "Infinity"]) {
      for (const l of out) {
        assert.ok(!l.includes(bad), `output contained "${bad}": ${l}`);
      }
    }
  });
});

describe("renderHistoryBlock", () => {
  it("SHOULD return an empty array WHEN sample_size is under 3 — Bug guarded: the adaptive threshold must hide the block", () => {
    const inputs: HistoryBlockInput[] = [
      { stats: statsAt(0), profile: "mixed", effective_usd: 10 },
      { stats: statsAt(1), profile: "mixed", effective_usd: 10 },
      { stats: statsAt(2), profile: "mixed", effective_usd: 10 },
    ];
    for (const input of inputs) {
      assert.deepEqual(renderHistoryBlock(input), []);
    }
  });

  it("SHOULD render header and profile comparison WHEN stats are sufficient", () => {
    const out = renderHistoryBlock({
      stats: statsAt(3),
      profile: "mixed",
      effective_usd: 66,
    });
    assert.ok(out[0].includes("Your history (n=3 sessions"));
    assert.ok(out[1].includes("This profile (mixed)"));
    assert.match(out[1], /175% above typical/);
  });

  it("SHOULD render header only WHEN the profile is missing from stats", () => {
    const out = renderHistoryBlock({
      stats: statsAt(3),
      profile: "edit-heavy",
      effective_usd: 66,
    });
    assert.equal(out.length, 1);
  });

  it("SHOULD render header only WHEN profile median is zero", () => {
    const out = renderHistoryBlock({
      stats: statsAt(3, {
        by_profile: {
          mixed: {
            n: 3,
            median_total_input: 0,
            median_output: 0,
            median_effective_usd: 0,
          },
        },
      }),
      profile: "mixed",
      effective_usd: 66,
    });
    assert.equal(out.length, 1);
  });

  it("SHOULD render header only WHEN effective_usd is null", () => {
    const out = renderHistoryBlock({
      stats: statsAt(3),
      profile: "mixed",
      effective_usd: null,
    });
    assert.equal(out.length, 1);
  });

  it("SHOULD label the direction as 'below' WHEN this session is cheaper than the median", () => {
    const out = renderHistoryBlock({
      stats: statsAt(3),
      profile: "mixed",
      effective_usd: 12,
    });
    assert.match(out[1], /below typical/);
  });
});

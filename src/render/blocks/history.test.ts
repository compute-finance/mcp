import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HistoryBlockInput, renderHistoryBlock } from "./history.js";
import { HistoryStats } from "../../storage/history.js";

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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OverheadBlockInput, renderOverheadBlock } from "./overhead.js";

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

  it("SHOULD render total with one decimal WHEN total_scu is below 10 — Bug guarded: a raw float total (e.g. 20.762938379045902) leaks into the headline for short sessions", () => {
    const out = renderOverheadBlock(
      overheadInput({
        fixed_overhead_tokens: 1_500,
        inferences: 8,
        scu_usd: 0.002,
        cached_input_usd_per_million: 0.3,
      }),
    );
    assert.match(out[1], /= \d\.\d SCU/);
  });

  it("SHOULD render total as a comma-separated integer WHEN total_scu is 1000 or more", () => {
    const out = renderOverheadBlock(
      overheadInput({
        fixed_overhead_tokens: 100_000,
        inferences: 200,
        scu_usd: 0.002,
        cached_input_usd_per_million: 0.5,
      }),
    );
    assert.match(out[1], /= \d,\d{3} SCU/);
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

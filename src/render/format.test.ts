import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { money, scuAmount, scuPrice, multiple } from "./format.js";

describe("money", () => {
  it("SHOULD keep four decimals FOR sub-dollar amounts", () => {
    assert.equal(money(0.7234), "$0.7234");
  });

  it("SHOULD use two decimals FOR amounts of one dollar or more", () => {
    assert.equal(money(52.0), "$52.00");
  });

  it("SHOULD insert thousands separators FOR amounts above one thousand — Bug guarded: reports must render `$1,490.00` rather than `$1490.00`", () => {
    assert.equal(money(1_490), "$1,490.00");
    assert.equal(money(1_000_000), "$1,000,000.00");
  });

  it("SHOULD return em-dash FOR null, undefined, and non-finite values", () => {
    assert.equal(money(null), "—");
    assert.equal(money(undefined), "—");
    assert.equal(money(NaN), "—");
    assert.equal(money(Infinity), "—");
  });
});

// scuAmount: whole-SCU figure, thousands-separated — guards rounding, separator placement, null/NaN.
describe("scuAmount", () => {
  it("SHOULD round a fractional SCU count to the nearest whole unit", () => {
    assert.equal(scuAmount(21358.7), "21,359");
  });

  it("SHOULD round half away from / to nearest — .5 goes up", () => {
    assert.equal(scuAmount(21358.5), "21,359");
  });

  it("SHOULD insert a thousands separator at each group, not just the first", () => {
    assert.equal(scuAmount(135543), "135,543");
  });

  it("SHOULD separate groups across millions", () => {
    assert.equal(scuAmount(1234567), "1,234,567");
  });

  it("SHOULD NOT add a separator below 1000", () => {
    assert.equal(scuAmount(999), "999");
  });

  it("SHOULD render the em-dash for null", () => {
    assert.equal(scuAmount(null), "—");
  });

  it("SHOULD render the em-dash for undefined", () => {
    assert.equal(scuAmount(undefined), "—");
  });

  it("SHOULD render the em-dash for a non-finite value — must not surface NaN/Infinity to the report", () => {
    assert.equal(scuAmount(NaN), "—");
    assert.equal(scuAmount(Infinity), "—");
  });
});

// scuPrice: 6 decimals — money()'s 4 would collapse the sub-cent SCU price.
describe("scuPrice", () => {
  it("SHOULD format a sub-cent unit price to exactly 6 decimals", () => {
    assert.equal(scuPrice(0.002434650581587041), "$0.002435");
  });

  it("SHOULD preserve precision that 4-decimal money() would collapse", () => {
    // 0.0024 at 4dp vs 0.002400 at 6dp — the extra digits are the point of this formatter.
    assert.equal(scuPrice(0.0024), "$0.002400");
  });

  it("SHOULD render the em-dash for null", () => {
    assert.equal(scuPrice(null), "—");
  });

  it("SHOULD render the em-dash for undefined", () => {
    assert.equal(scuPrice(undefined), "—");
  });

  it("SHOULD render the em-dash for a non-finite value", () => {
    assert.equal(scuPrice(NaN), "—");
    assert.equal(scuPrice(Infinity), "—");
  });
});

// multiple: "× index" multiplier — one decimal below 10, whole number at/above (`7.2×`, `12×`).
describe("multiple", () => {
  it("SHOULD render one decimal below 10", () => {
    assert.equal(multiple(7.2), "7.2×");
    assert.equal(multiple(0.3), "0.3×");
  });

  it("SHOULD switch to a whole number AT the 10× boundary, one decimal just below it", () => {
    // 10 is the inclusive cutover: at/above → no decimal, just below → one decimal.
    assert.equal(multiple(10), "10×");
    assert.equal(multiple(9.9), "9.9×");
  });

  it("SHOULD render large values with no decimal", () => {
    assert.equal(multiple(12), "12×");
  });

  it("SHOULD render the em-dash for null", () => {
    assert.equal(multiple(null), "—");
  });

  it("SHOULD render the em-dash for undefined", () => {
    assert.equal(multiple(undefined), "—");
  });

  it("SHOULD render the em-dash for a non-finite value — must not surface NaN/Infinity to the report", () => {
    assert.equal(multiple(NaN), "—");
    assert.equal(multiple(Infinity), "—");
  });
});

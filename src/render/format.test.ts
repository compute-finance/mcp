import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { money } from "./format.js";

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

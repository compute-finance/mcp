import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TokenCounts,
  money,
  tokensSplit,
  tokensFootprint,
  renderTokensBlock,
} from "./format.js";

function counts(overrides: Partial<TokenCounts> = {}): TokenCounts {
  return {
    raw_input_tokens: 100_000,
    cache_read_tokens: 21_100_000,
    cache_creation_tokens: 2_600_000,
    output_tokens: 400_000,
    ...overrides,
  };
}

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

describe("tokensSplit", () => {
  it("SHOULD render the four-way split in fresh/cache-read/cache-write/output order", () => {
    const out = tokensSplit(counts());
    assert.equal(
      out,
      "100.0k fresh · 21.1M cache-read · 2.6M cache-write · 400.0k output",
    );
  });

  it("SHOULD render zero counts WHEN a segment is empty", () => {
    const out = tokensSplit(
      counts({
        raw_input_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        output_tokens: 1234,
      }),
    );
    assert.equal(out, "0 fresh · 0 cache-read · 0 cache-write · 1.2k output");
  });
});

describe("tokensFootprint", () => {
  it("SHOULD compute context as cache_read divided by inferences", () => {
    const out = tokensFootprint(counts({ cache_read_tokens: 21_000_000 }), 100);
    assert.match(out!, /≈ 210\.0k context/);
    assert.match(out!, /re-read ×100/);
  });

  it("SHOULD reconcile the legacy total against the sum of the four components", () => {
    const t = counts();
    const expected = (
      (t.raw_input_tokens +
        t.cache_read_tokens +
        t.cache_creation_tokens +
        t.output_tokens) /
      1_000_000
    ).toFixed(1);
    const out = tokensFootprint(t, 115);
    assert.ok(
      out!.includes(`not ${expected}M`),
      `expected the legacy total ${expected}M to appear; got: ${out}`,
    );
  });

  it("SHOULD return null WHEN inferences is zero", () => {
    assert.equal(tokensFootprint(counts(), 0), null);
  });

  it("SHOULD return null WHEN cache_read is zero", () => {
    assert.equal(tokensFootprint(counts({ cache_read_tokens: 0 }), 5), null);
  });

  it("SHOULD never emit NaN/Infinity FOR adversarial counts", () => {
    const out = tokensFootprint(
      counts({
        raw_input_tokens: 1,
        cache_read_tokens: 1_000_000_000,
        cache_creation_tokens: 1,
        output_tokens: 1,
      }),
      1,
    );
    assert.ok(out !== null);
    for (const bad of ["NaN", "Infinity"]) {
      assert.ok(!out!.includes(bad), `output contained "${bad}": ${out}`);
    }
  });
});

describe("renderTokensBlock", () => {
  it("SHOULD return two lines WHEN cache reads exist", () => {
    const out = renderTokensBlock(counts(), 100);
    assert.equal(out.length, 2);
    assert.ok(out[0].startsWith("Tokens: "));
    assert.ok(out[1].startsWith("        ≈ "));
  });

  it("SHOULD return only the split line WHEN footprint cannot be computed", () => {
    const out = renderTokensBlock(counts({ cache_read_tokens: 0 }), 0);
    assert.equal(out.length, 1);
    assert.ok(out[0].startsWith("Tokens: "));
  });

  it("SHOULD align the footprint indent with the prefix width — Bug guarded: a renamed prefix must not desync the indent", () => {
    const out = renderTokensBlock(counts(), 50);
    const prefixWidth = out[0].indexOf(out[0].split(": ")[1]);
    const indentWidth = out[1].length - out[1].trimStart().length;
    assert.equal(indentWidth, prefixWidth);
  });
});

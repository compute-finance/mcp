/**
 * Unit tests for resolveCanonicalIn (and its internal canonicalizeIn).
 *
 * Run with: npx tsx --test src/oracle/client.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCanonicalIn } from "./client.js";
import type { ModelPrice } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────

/** Minimal ModelPrice stub — only `model` matters for canonicalization. */
function mp(model: string): ModelPrice {
  return {
    model,
    display_name: model,
    provider: "test",
    provider_name: "Test",
    tier: "frontier",
    integrated: true,
    released_at: null,
    input_usd_per_million: 1,
    output_usd_per_million: 1,
    input_wei_per_million: 1,
    output_wei_per_million: 1,
    cache: { read: 0.1, write_5m: 1.25, write_1h: 1.25, source: "local-fallback" },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("resolveCanonicalIn", () => {
  const basket = [
    mp("claude-opus-4.7"),
    mp("claude-sonnet-4.5"),
    mp("gpt-5.4"),
    mp("gemini-3.1-pro"),
  ];

  // --- null / undefined input ---

  it("returns null for null input", () => {
    assert.equal(resolveCanonicalIn(null, basket), null);
  });

  it("returns null for undefined input", () => {
    assert.equal(resolveCanonicalIn(undefined, basket), null);
  });

  // --- exact match ---

  it("returns exact match when model is in basket", () => {
    assert.equal(resolveCanonicalIn("claude-opus-4.7", basket), "claude-opus-4.7");
  });

  // --- bracket stripping ---

  it("strips trailing bracket annotations", () => {
    assert.equal(
      resolveCanonicalIn("claude-opus-4.7[some-annotation]", basket),
      "claude-opus-4.7",
    );
  });

  // --- date suffix stripping ---

  it("strips trailing date suffixes (8+ digits)", () => {
    assert.equal(
      resolveCanonicalIn("claude-opus-4.7-20250501", basket),
      "claude-opus-4.7",
    );
  });

  // --- dot normalization (digit-hyphen-digit → digit.digit) ---

  it("normalizes digit-hyphen-digit to digit.digit", () => {
    assert.equal(resolveCanonicalIn("claude-opus-4-7", basket), "claude-opus-4.7");
  });

  it("normalizes gpt model with hyphen version", () => {
    assert.equal(resolveCanonicalIn("gpt-5-4", basket), "gpt-5.4");
  });

  // --- family fallback: closest version ---

  it("falls back to closest version in same family", () => {
    // claude-opus-4.6 not in basket, but claude-opus-4.7 is
    assert.equal(resolveCanonicalIn("claude-opus-4.6", basket), "claude-opus-4.7");
  });

  it("picks closest version when multiple family members exist", () => {
    const multiBasket = [mp("claude-opus-4.5"), mp("claude-opus-4.7"), mp("claude-opus-5.0")];
    // 4.6 is closest to 4.5 (dist=0.1) and 4.7 (dist=0.1) — tie.
    // Implementation iterates Set, picks last-wins with <, so either is acceptable.
    const result = resolveCanonicalIn("claude-opus-4.6", multiBasket);
    assert.ok(
      result === "claude-opus-4.5" || result === "claude-opus-4.7",
      `Expected claude-opus-4.5 or claude-opus-4.7, got ${result}`,
    );
  });

  it("picks nearest when distances are unequal", () => {
    const multiBasket = [mp("claude-opus-4.5"), mp("claude-opus-5.0")];
    // 4.8 → dist to 4.5 = 0.3, dist to 5.0 = 0.2 → picks 5.0
    assert.equal(resolveCanonicalIn("claude-opus-4.8", multiBasket), "claude-opus-5.0");
  });

  // --- family fallback via dot normalization + family ---

  it("applies dot normalization before family fallback", () => {
    // claude-opus-4-6 → dot-normalized to claude-opus-4.6 → family fallback → 4.7
    assert.equal(resolveCanonicalIn("claude-opus-4-6", basket), "claude-opus-4.7");
  });

  // --- no match at all ---

  it("returns null when no family matches", () => {
    assert.equal(resolveCanonicalIn("llama-4-maverick", basket), null);
  });

  it("returns null for completely unrelated model name", () => {
    assert.equal(resolveCanonicalIn("deepseek-r2", basket), null);
  });

  // --- empty basket ---

  it("returns null with empty basket", () => {
    assert.equal(resolveCanonicalIn("claude-opus-4.7", []), null);
  });
});

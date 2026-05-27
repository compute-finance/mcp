import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  requireString,
  requireFiniteNumber,
  checkOptionalSessionId,
} from "./validation.js";

describe("requireString", () => {
  it("returns the string when valid", () => {
    assert.equal(requireString("claude-opus-4.7", "model"), "claude-opus-4.7");
  });

  it("returns error when undefined — prevents NaN in costUsd", () => {
    const result = requireString(undefined, "model");
    assert.equal(typeof result, "object");
    assert.ok("error" in (result as object));
  });

  it("returns error for empty string", () => {
    const result = requireString("", "model");
    assert.equal(typeof result, "object");
    assert.ok("error" in (result as object));
  });
});

describe("requireFiniteNumber", () => {
  it("returns the number when valid", () => {
    assert.equal(requireFiniteNumber(50000, "input_tokens"), 50000);
  });

  it("returns error for NaN — prevents silent poison in billing", () => {
    const result = requireFiniteNumber(NaN, "input_tokens");
    assert.equal(typeof result, "object");
    assert.ok("error" in (result as object));
  });

  it("returns error for negative — token counts cannot be negative", () => {
    const result = requireFiniteNumber(-1, "input_tokens");
    assert.equal(typeof result, "object");
    assert.ok("error" in (result as object));
  });

  it("returns error for Infinity", () => {
    const result = requireFiniteNumber(Infinity, "input_tokens");
    assert.equal(typeof result, "object");
    assert.ok("error" in (result as object));
  });
});

describe("checkOptionalSessionId", () => {
  it("returns undefined when not provided", () => {
    assert.equal(checkOptionalSessionId(undefined), undefined);
  });

  it("returns the id when UUID-shaped", () => {
    const id = "abc123-def456";
    assert.equal(checkOptionalSessionId(id), id);
  });

  it("returns error for path-traversal attempt — prevents fs read outside sessions dir", () => {
    const result = checkOptionalSessionId("../../etc/passwd");
    assert.equal(typeof result, "object");
    assert.ok("error" in (result as object));
  });
});

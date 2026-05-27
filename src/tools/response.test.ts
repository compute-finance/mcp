import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errorText, text } from "./response.js";

describe("errorText", () => {
  it("sets isError: true so MCP clients detect errors without parsing body", () => {
    const result = errorText("something broke");
    assert.equal(result.isError, true);
  });

  it("includes the error message in content text", () => {
    const result = errorText("Model not in basket: foo");
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.error, "Model not in basket: foo");
  });
});

describe("text (non-error)", () => {
  it("does not set isError", () => {
    const result = text({ data: 1 });
    assert.equal("isError" in result, false);
  });
});

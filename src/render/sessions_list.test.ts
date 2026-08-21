import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderSessionsTable, type SessionRow } from "./sessions_list.js";

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session: "0a1b2c3d",
    model: "anthropic/claude-opus-4.8",
    prompts: 12,
    inferences: 34,
    tool_calls: 56,
    input_tokens: 1_250_000,
    output_tokens: 48_000,
    effective_usd: 0.4321,
    nominal_usd: 0.8765,
    last_active: "2026-08-21 10:31",
    ...over,
  };
}

describe("renderSessionsTable", () => {
  it("SHOULD print a canonical vendor-prefixed model id in full — Bug guarded: a clipped 'anthropic/claude-opu' names no model", () => {
    const [, session] = renderSessionsTable([row()]);
    assert.ok(session.includes("anthropic/claude-opus-4.8"), session);
  });

  it("SHOULD keep the numeric columns aligned WHEN model ids differ in length", () => {
    const [header, longId, shortId] = renderSessionsTable([
      row({ model: "google/gemini-3.1-flash-lite", prompts: 12 }),
      row({ model: "gpt-5.5", prompts: 7 }),
    ]);
    const promptsEnd = header.indexOf("prompts") + "prompts".length;
    assert.equal(longId.slice(promptsEnd - 2, promptsEnd), "12");
    assert.equal(shortId.slice(promptsEnd - 1, promptsEnd), "7");
  });

  it("SHOULD emit the header alone FOR an empty session list", () => {
    const lines = renderSessionsTable([]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("model"));
  });
});

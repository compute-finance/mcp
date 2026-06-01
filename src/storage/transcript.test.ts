import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseTranscript } from "./transcript.js";
import { summarizeSession } from "./session.js";
import { analyzeInferences } from "./inferences.js";

const FIXTURE_LINES: unknown[] = [
  // P0
  {
    type: "user",
    timestamp: "2026-05-30T10:00:00.000Z",
    message: { role: "user", content: "first user question" },
  },
  // I0 (plain reply)
  {
    type: "assistant",
    timestamp: "2026-05-30T10:00:01.000Z",
    message: {
      model: "claude-opus-4.7",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 5000,
        output_tokens: 50,
      },
      content: [{ type: "text", text: "plain reply" }],
    },
  },
  // P1 (tool loop trigger)
  {
    type: "user",
    timestamp: "2026-05-30T10:01:00.000Z",
    message: { role: "user", content: "do a few file ops" },
  },
  // I1 (tool_use Read)
  {
    type: "assistant",
    timestamp: "2026-05-30T10:01:01.000Z",
    message: {
      model: "claude-opus-4.7",
      usage: {
        input_tokens: 50,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 0,
        output_tokens: 30,
      },
      content: [{ type: "tool_use", name: "Read", input: { path: "/a" } }],
    },
  },
  // tool_result reply (this is a "user" record but NOT a prompt)
  {
    type: "user",
    timestamp: "2026-05-30T10:01:02.000Z",
    toolUseResult: { content: "file contents" },
    message: { role: "user", content: [{ type: "tool_result" }] },
  },
  // I2 (tool_use Edit + Read in one inference)
  {
    type: "assistant",
    timestamp: "2026-05-30T10:01:03.000Z",
    message: {
      model: "claude-opus-4.7",
      usage: {
        input_tokens: 60,
        cache_read_input_tokens: 4200,
        cache_creation_input_tokens: 0,
        output_tokens: 40,
      },
      content: [
        { type: "tool_use", name: "Edit", input: {} },
        { type: "tool_use", name: "Read", input: {} },
      ],
    },
  },
  // another tool_result (NOT a prompt)
  {
    type: "user",
    timestamp: "2026-05-30T10:01:04.000Z",
    toolUseResult: { content: "ok" },
    message: { role: "user", content: [{ type: "tool_result" }] },
  },
  // I3 (plain text — closes loop)
  {
    type: "assistant",
    timestamp: "2026-05-30T10:01:05.000Z",
    message: {
      model: "claude-opus-4.7",
      usage: {
        input_tokens: 70,
        cache_read_input_tokens: 4400,
        cache_creation_input_tokens: 0,
        output_tokens: 60,
      },
      content: [{ type: "text", text: "done" }],
    },
  },
  // P2 (final question)
  {
    type: "user",
    timestamp: "2026-05-30T10:02:00.000Z",
    message: { role: "user", content: "summarize" },
  },
  // I4 (thinking + tool_use)
  {
    type: "assistant",
    timestamp: "2026-05-30T10:02:01.000Z",
    message: {
      model: "claude-opus-4.7",
      usage: {
        input_tokens: 80,
        cache_read_input_tokens: 4600,
        cache_creation_input_tokens: 0,
        output_tokens: 250,
      },
      content: [
        { type: "thinking", thinking: "..." },
        { type: "tool_use", name: "Grep", input: {} },
        { type: "text", text: "here you go" },
      ],
    },
  },
];

let dir: string;
let path: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "cf-mcp-transcript-"));
  path = join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
  const body = FIXTURE_LINES.map((line) => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(path, body);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseTranscript", () => {
  it("counts user prompts only, excluding tool_result replies", () => {
    const t = parseTranscript(path);
    assert.equal(t.prompts.length, 3);
  });

  it("counts assistant messages as inferences (5 in fixture)", () => {
    const t = parseTranscript(path);
    assert.equal(t.inferences.length, 5);
  });

  it("links each inference to its parent prompt via prompt_index", () => {
    const t = parseTranscript(path);
    assert.equal(t.inferences[0].prompt_index, 0); // I0 ← P0
    assert.equal(t.inferences[1].prompt_index, 1); // I1 ← P1
    assert.equal(t.inferences[2].prompt_index, 1); // I2 ← P1 (tool loop)
    assert.equal(t.inferences[3].prompt_index, 1); // I3 ← P1 (tool loop)
    assert.equal(t.inferences[4].prompt_index, 2); // I4 ← P2
  });

  it("captures tool_use blocks per inference (4 total)", () => {
    const t = parseTranscript(path);
    const tools = t.inferences.reduce(
      (acc, inf) => acc + inf.tool_use_blocks,
      0,
    );
    assert.equal(tools, 4);
  });

  it("captures extended thinking in the final inference", () => {
    const t = parseTranscript(path);
    assert.equal(t.inferences[4].thinking_blocks, 1);
  });
});

describe("summarizeSession", () => {
  it("exposes prompts/inferences/tool_calls triplet matching the transcript", () => {
    const t = parseTranscript(path);
    const u = summarizeSession(t);
    assert.equal(u.prompts, 3);
    assert.equal(u.inferences, 5);
    assert.equal(u.tool_calls, 4);
  });

  it("classifies edits/reads by tool name and flags extended thinking", () => {
    const t = parseTranscript(path);
    const u = summarizeSession(t);
    assert.equal(u.edits, 1); // Edit in I2
    assert.equal(u.reads, 3); // Read in I1, Read in I2, Grep in I4
    assert.equal(u.extended_thinking_used, true);
  });

  it("sums token columns across all inferences", () => {
    const t = parseTranscript(path);
    const u = summarizeSession(t);
    assert.equal(u.raw_input_tokens, 100 + 50 + 60 + 70 + 80);
    assert.equal(u.cache_read_tokens, 0 + 4000 + 4200 + 4400 + 4600);
    assert.equal(u.cache_creation_tokens, 5000);
    assert.equal(u.output_tokens, 50 + 30 + 40 + 60 + 250);
  });
});

describe("analyzeInferences", () => {
  it("reports total_inferences equal to assistant message count", () => {
    const t = parseTranscript(path);
    const a = analyzeInferences(t);
    assert.equal(a.total_inferences, 5);
    assert.equal(a.inferences.length, 5);
  });

  it("aggregates by_tool with calls and inferences_with_tool", () => {
    const t = parseTranscript(path);
    const a = analyzeInferences(t);
    // Read appears once in I1 and once in I2 → 2 calls across 2 inferences
    assert.equal(a.by_tool.Read.calls, 2);
    assert.equal(a.by_tool.Read.inferences_with_tool, 2);
    // Edit appears once in I2 → 1 call in 1 inference
    assert.equal(a.by_tool.Edit.calls, 1);
    assert.equal(a.by_tool.Edit.inferences_with_tool, 1);
    // Grep appears once in I4 → 1 call in 1 inference
    assert.equal(a.by_tool.Grep.calls, 1);
    assert.equal(a.by_tool.Grep.inferences_with_tool, 1);
  });
});


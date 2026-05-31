import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateLegacyRow } from "./history.js";
import {
  normalizePersistedRow,
  logInferences,
  LoggedInference,
} from "./inferences.js";

describe("migrateLegacyRow (history.jsonl)", () => {
  it("lifts legacy `turns` into `prompts` when no `prompts` field exists", () => {
    const legacy = {
      session_id: "abc",
      ts: "2026-05-01T00:00:00Z",
      model: "claude-opus-4.6",
      in_basket: true,
      profile: "edit-heavy",
      raw_input_tokens: 100,
      cache_read_tokens: 5000,
      cache_creation_tokens: 200,
      output_tokens: 50,
      turns: 7,
      tool_calls: 12,
      edits: 3,
      reads: 4,
      extended_thinking_used: false,
      effective_usd: 0.1,
      nominal_usd: 0.5,
      out_in_ratio: 0.5,
    };
    const migrated = migrateLegacyRow(legacy);
    assert.equal(migrated.prompts, 7);
    assert.equal(migrated.inferences, null);
  });

  it("keeps a modern row's prompts/inferences untouched", () => {
    const modern = {
      session_id: "abc",
      prompts: 4,
      inferences: 17,
      tool_calls: 8,
    };
    const migrated = migrateLegacyRow(modern);
    assert.equal(migrated.prompts, 4);
    assert.equal(migrated.inferences, 17);
  });

  it("drops the obsolete `turns` field from the migrated row", () => {
    const legacy = { session_id: "abc", turns: 5 };
    const migrated = migrateLegacyRow(legacy) as Record<string, unknown>;
    assert.equal("turns" in migrated, false);
  });

  it("does not mutate its input (immutability contract)", () => {
    const legacy = { session_id: "abc", turns: 5 };
    migrateLegacyRow(legacy);
    assert.equal(legacy.turns, 5);
    assert.equal("prompts" in legacy, false);
  });

  it("defaults prompts to 0 when neither `prompts` nor `turns` is present", () => {
    const broken = { session_id: "abc" };
    const migrated = migrateLegacyRow(broken);
    assert.equal(migrated.prompts, 0);
    assert.equal(migrated.inferences, null);
  });
});

describe("normalizePersistedRow (inferences.jsonl)", () => {
  it("lifts legacy `turn_index` into `inference_index`", () => {
    const legacy = {
      session_id: "abc",
      ts: "2026-05-01T00:00:00Z",
      turn_index: 42,
      raw_input_tokens: 100,
      cache_read_tokens: 5000,
      cache_creation_tokens: 0,
      output_tokens: 50,
      thinking_blocks: 0,
      text_blocks: 1,
      tool_use_blocks: 0,
      tools_used: ["Read"],
      duration_ms: 1200,
      comment: "plain",
    };
    const r = normalizePersistedRow(legacy);
    assert.equal(r.index, 42);
  });

  it("rejects NaN-poisoned numeric fields (defaults to 0)", () => {
    const corrupt = {
      session_id: "abc",
      inference_index: "not-a-number",
      raw_input_tokens: "broken",
      cache_read_tokens: Infinity,
      cache_creation_tokens: NaN,
      output_tokens: null,
    };
    const r = normalizePersistedRow(corrupt);
    assert.equal(r.index, 0);
    assert.equal(r.raw_input_tokens, 0);
    assert.equal(r.cache_read_tokens, 0);
    assert.equal(r.cache_creation_tokens, 0);
    assert.equal(r.output_tokens, 0);
  });

  it("filters non-string entries from tools_used (no undefined leakage)", () => {
    const dirty = {
      session_id: "abc",
      tools_used: ["Read", 42, null, "Edit"],
    };
    const r = normalizePersistedRow(dirty);
    assert.deepEqual(r.tools_used, ["Read", "Edit"]);
  });

  it("falls back to comment='—' when comment is missing or non-string", () => {
    const missing = { session_id: "abc" };
    assert.equal(normalizePersistedRow(missing).comment, "—");
    const wrongType = { session_id: "abc", comment: 99 };
    assert.equal(normalizePersistedRow(wrongType).comment, "—");
  });
});

describe("logInferences (dedupe + legacy fallback)", () => {
  let dir: string;
  const sessionId = "11111111-2222-3333-4444-555555555555";

  function sampleInference(idx: number): LoggedInference {
    return {
      session_id: sessionId,
      ts: "2026-05-30T10:00:00Z",
      index: idx,
      prompt_index: 0,
      model: "claude-opus-4.7",
      raw_input_tokens: 100,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      output_tokens: 50,
      thinking_blocks: 0,
      text_blocks: 1,
      tool_use_blocks: 0,
      tools_used: [],
      duration_ms: 100,
      comment: "—",
    };
  }

  function readJsonl(path: string): Record<string, unknown>[] {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-mcp-migration-"));
    process.env.COMPUTE_FINANCE_DIR = dir;
  });

  beforeEach(() => {
    for (const f of ["inferences.jsonl", "turns.jsonl"]) {
      const p = join(dir, f);
      if (existsSync(p)) rmSync(p);
    }
  });

  after(() => {
    delete process.env.COMPUTE_FINANCE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedupes rows for the same session_id across re-runs (no file balloon)", () => {
    logInferences([sampleInference(0), sampleInference(1)]);
    logInferences([sampleInference(0), sampleInference(1), sampleInference(2)]);
    const rows = readJsonl(join(dir, "inferences.jsonl"));
    assert.equal(rows.length, 3);
    for (const r of rows) assert.equal(r.session_id, sessionId);
  });

  it("preserves rows from other sessions when relogging this one", () => {
    const other: LoggedInference = { ...sampleInference(0), session_id: "other" };
    logInferences([other]);
    logInferences([sampleInference(0), sampleInference(1)]);
    const rows = readJsonl(join(dir, "inferences.jsonl"));
    const bySession = rows.reduce<Record<string, number>>((acc, r) => {
      const sid = String(r.session_id);
      acc[sid] = (acc[sid] ?? 0) + 1;
      return acc;
    }, {});
    assert.equal(bySession.other, 1);
    assert.equal(bySession[sessionId], 2);
  });

  it("reads from legacy turns.jsonl and migrates rows into inferences.jsonl on first write", () => {
    const legacyRow = {
      session_id: "legacy-session",
      ts: "2026-04-01T00:00:00Z",
      turn_index: 5,
      raw_input_tokens: 10,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      output_tokens: 5,
      thinking_blocks: 0,
      text_blocks: 1,
      tool_use_blocks: 0,
      tools_used: ["Read"],
      duration_ms: 100,
      comment: "—",
    };
    writeFileSync(
      join(dir, "turns.jsonl"),
      JSON.stringify(legacyRow) + "\n",
    );

    logInferences([sampleInference(0)]);

    const rows = readJsonl(join(dir, "inferences.jsonl"));
    assert.equal(rows.length, 2);
    const legacyMigrated = rows.find((r) => r.session_id === "legacy-session");
    assert.ok(legacyMigrated, "legacy row must survive migration");
    assert.equal(legacyMigrated.index, 5);
    assert.equal("turn_index" in legacyMigrated, false);
  });
});

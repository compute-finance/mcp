import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStats, SessionRecord } from "./history.js";

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cf-history-"));
  process.env.COMPUTE_FINANCE_DIR = tmpDir;
});

after(() => {
  delete process.env.COMPUTE_FINANCE_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeRecords(records: Partial<SessionRecord>[]): void {
  const lines = records.map((partial, i) =>
    JSON.stringify({
      session_id: `s${i}`,
      ts: new Date(2026, 0, i + 1).toISOString(),
      model: "claude-opus-4.7",
      in_basket: true,
      profile: "mixed",
      raw_input_tokens: 1000,
      cache_read_tokens: 100_000,
      cache_creation_tokens: 5000,
      output_tokens: 2000,
      prompts: 10,
      inferences: 20,
      tool_calls: 5,
      edits: 2,
      reads: 3,
      extended_thinking_used: false,
      effective_usd: 1.0,
      nominal_usd: 5.0,
      out_in_ratio: 0.02,
      ...partial,
    }),
  );
  writeFileSync(join(tmpDir, "sessions.jsonl"), lines.join("\n") + "\n");
}

describe("getStats", () => {
  beforeEach(() => {
    writeFileSync(join(tmpDir, "sessions.jsonl"), "");
  });

  it("SHOULD return zero counts WHEN history is empty", async () => {
    const stats = await getStats();
    assert.equal(stats.sample_size, 0);
    assert.equal(stats.distinct_sessions, 0);
    assert.equal(stats.cumulative_effective_usd, 0);
    assert.deepEqual(stats.by_profile, {});
  });

  it("SHOULD include every record WHEN no excludeSessionId is given", async () => {
    writeRecords([{}, {}, {}]);
    const stats = await getStats();
    assert.equal(stats.sample_size, 3);
    assert.equal(stats.distinct_sessions, 3);
  });

  it("SHOULD drop the matching session WHEN excludeSessionId is given — Bug guarded: a session's own record must not feed its own median", async () => {
    writeRecords([
      { session_id: "a", effective_usd: 10 },
      { session_id: "b", effective_usd: 20 },
      { session_id: "c", effective_usd: 30 },
    ]);
    const stats = await getStats("b");
    assert.equal(stats.sample_size, 2);
    assert.equal(stats.cumulative_effective_usd, 40);
    assert.equal(stats.by_profile.mixed.median_effective_usd, 20);
  });

  it("SHOULD be a no-op WHEN excludeSessionId does not match any record", async () => {
    writeRecords([
      { session_id: "a", effective_usd: 10 },
      { session_id: "b", effective_usd: 20 },
    ]);
    const stats = await getStats("ghost");
    assert.equal(stats.sample_size, 2);
    assert.equal(stats.cumulative_effective_usd, 30);
  });

  it("SHOULD report zero sample_size WHEN excluding leaves no records", async () => {
    writeRecords([{ session_id: "only" }]);
    const stats = await getStats("only");
    assert.equal(stats.sample_size, 0);
    assert.deepEqual(stats.by_profile, {});
  });

  it("SHOULD partition median per profile AFTER excluding the session", async () => {
    writeRecords([
      { session_id: "a", profile: "edit-heavy", effective_usd: 5 },
      { session_id: "b", profile: "edit-heavy", effective_usd: 7 },
      { session_id: "c", profile: "edit-heavy", effective_usd: 9 },
      { session_id: "d", profile: "reasoning-heavy", effective_usd: 100 },
    ]);
    const stats = await getStats("c");
    assert.equal(stats.by_profile["edit-heavy"].n, 2);
    assert.equal(stats.by_profile["edit-heavy"].median_effective_usd, 6);
    assert.equal(stats.by_profile["reasoning-heavy"].n, 1);
  });
});

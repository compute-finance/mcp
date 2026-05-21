import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".compute-finance");
const TURNS = join(DIR, "turns.jsonl");

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export interface TurnRecord {
  session_id: string;
  ts: string;
  turn_index: number;
  model: string | null;
  raw_input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  thinking_blocks: number;
  text_blocks: number;
  tool_use_blocks: number;
  tools_used: string[];
  duration_ms: number | null;
  comment: string;
}

export interface TurnAnalysis {
  session_id: string;
  model: string | null;
  total_turns: number;
  turns: TurnRecord[];
  totals: {
    raw_input_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    output_tokens: number;
  };
  by_tool: Record<string, { calls: number; turns_with_tool: number }>;
  cache_hit_ratio: number;
}

import { EDIT_TOOLS, READ_TOOLS, isHumanUserTurn } from "./tools.js";

function buildComment(t: Omit<TurnRecord, "comment" | "ts">): string {
  const parts: string[] = [];
  const totalIn = t.raw_input_tokens + t.cache_read_tokens + t.cache_creation_tokens;

  // Cache state
  if (totalIn > 0) {
    const hitRatio = t.cache_read_tokens / totalIn;
    if (t.cache_creation_tokens > 5000 && t.cache_read_tokens < 1000) {
      parts.push("first turn / cache miss — paying to fill cache");
    } else if (hitRatio > 0.9) {
      parts.push(`cache fully warm (${Math.round(hitRatio * 100)}% reads)`);
    } else if (hitRatio < 0.3 && t.cache_creation_tokens > 1000) {
      parts.push("context grew — partial cache write");
    }
  }

  // Output shape
  if (t.thinking_blocks > 0 && t.output_tokens > 2000) {
    parts.push(`reasoning-heavy (${t.thinking_blocks} thinking blocks)`);
  } else if (t.tool_use_blocks > 0 && t.text_blocks === 0) {
    parts.push(`tool-only turn (${t.tool_use_blocks} calls, no text reply)`);
  } else if (t.tool_use_blocks === 0 && t.thinking_blocks === 0) {
    parts.push("plain text reply");
  }

  // Tool flavor
  const editCount = t.tools_used.filter((n) => EDIT_TOOLS.has(n)).length;
  const readCount = t.tools_used.filter((n) => READ_TOOLS.has(n)).length;
  if (editCount > 0 && t.output_tokens > 1000) {
    parts.push("output dominated by file content");
  } else if (readCount >= 3) {
    parts.push("research-heavy turn");
  }

  return parts.length ? parts.join(" · ") : "—";
}

export function parseTurns(transcriptPath: string): TurnAnalysis {
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  const session_id = transcriptPath
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/\.jsonl$/, "");

  const turns: TurnRecord[] = [];
  let currentModel: string | null = null;
  let lastUserTs: string | null = null;
  let turnIndex = 0;

  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    if (rec.type === "user") {
      if (isHumanUserTurn(rec)) lastUserTs = rec.timestamp ?? null;
      continue;
    }
    if (rec.type !== "assistant") continue;

    const msg = rec.message;
    if (!msg) continue;
    if (msg.model) currentModel = msg.model;

    const usage = msg.usage ?? {};
    const content = Array.isArray(msg.content) ? msg.content : [];

    let thinking_blocks = 0;
    let text_blocks = 0;
    let tool_use_blocks = 0;
    const tools_used: string[] = [];

    for (const block of content) {
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        thinking_blocks += 1;
      } else if (block.type === "text") {
        text_blocks += 1;
      } else if (block.type === "tool_use") {
        tool_use_blocks += 1;
        if (block.name) tools_used.push(block.name);
      }
    }

    const ts = rec.timestamp ?? null;
    let duration_ms: number | null = null;
    if (lastUserTs && ts) {
      duration_ms = new Date(ts).getTime() - new Date(lastUserTs).getTime();
      if (duration_ms < 0) duration_ms = null;
    }

    const partial = {
      session_id,
      turn_index: turnIndex,
      model: currentModel,
      raw_input_tokens: usage.input_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      thinking_blocks,
      text_blocks,
      tool_use_blocks,
      tools_used,
      duration_ms,
    };

    turns.push({
      ...partial,
      ts: ts ?? new Date().toISOString(),
      comment: buildComment(partial),
    });

    turnIndex += 1;
  }

  const totals = turns.reduce(
    (acc, t) => ({
      raw_input_tokens: acc.raw_input_tokens + t.raw_input_tokens,
      cache_read_tokens: acc.cache_read_tokens + t.cache_read_tokens,
      cache_creation_tokens: acc.cache_creation_tokens + t.cache_creation_tokens,
      output_tokens: acc.output_tokens + t.output_tokens,
    }),
    {
      raw_input_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      output_tokens: 0,
    },
  );

  const by_tool: Record<string, { calls: number; turns_with_tool: number }> = {};
  for (const t of turns) {
    const seen = new Set<string>();
    for (const name of t.tools_used) {
      by_tool[name] ??= { calls: 0, turns_with_tool: 0 };
      by_tool[name].calls += 1;
      if (!seen.has(name)) {
        by_tool[name].turns_with_tool += 1;
        seen.add(name);
      }
    }
  }

  const totalIn =
    totals.raw_input_tokens + totals.cache_read_tokens + totals.cache_creation_tokens;
  const cache_hit_ratio = totalIn > 0 ? totals.cache_read_tokens / totalIn : 0;

  return {
    session_id,
    model: currentModel,
    total_turns: turns.length,
    turns,
    totals,
    by_tool,
    cache_hit_ratio,
  };
}

export function logTurns(turns: TurnRecord[]): { logged: number; path: string } {
  ensureDir();
  if (turns.length === 0) {
    return { logged: 0, path: "~/.compute-finance/turns.jsonl" };
  }
  // Dedupe-on-write: re-running the skill on the same session must not
  // balloon the file with duplicate rows. One batch always belongs to a
  // single session (built by parseTurns), so we strip every prior row that
  // shares this session_id, then append the fresh batch.
  //
  // Atomic: write everything to a tmp file, then rename. Avoids a torn file
  // if the process dies mid-rewrite — readers either see the old full log
  // or the new full log, never a half-written state.
  const sid = turns[0].session_id;
  const kept: string[] = [];
  if (existsSync(TURNS)) {
    for (const l of readFileSync(TURNS, "utf8").split("\n")) {
      if (!l) continue;
      try {
        if ((JSON.parse(l) as TurnRecord).session_id !== sid) kept.push(l);
      } catch {
        /* drop corrupt lines while we're rewriting anyway */
      }
    }
  }
  const fresh = turns.map((t) => JSON.stringify(t));
  const body = [...kept, ...fresh].join("\n") + "\n";
  const tmp = TURNS + ".tmp";
  writeFileSync(tmp, body);
  renameSync(tmp, TURNS);
  return { logged: turns.length, path: "~/.compute-finance/turns.jsonl" };
}

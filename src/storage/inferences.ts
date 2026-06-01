import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { EDIT_TOOLS, READ_TOOLS } from "./tools.js";
import { InferenceRecord, Transcript } from "./transcript.js";

function storageDir(): string {
  return process.env.COMPUTE_FINANCE_DIR ?? join(homedir(), ".compute-finance");
}

function persistedPath(): string {
  return join(storageDir(), "inferences.jsonl");
}

function ensureDir(): void {
  const dir = storageDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export interface LoggedInference extends InferenceRecord {
  session_id: string;
  ts: string | null;
  comment: string;
}

export interface InferenceAnalysis {
  session_id: string;
  model: string | null;
  total_inferences: number;
  inferences: LoggedInference[];
  totals: {
    raw_input_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    output_tokens: number;
  };
  by_tool: Record<string, { calls: number; inferences_with_tool: number }>;
  cache_hit_ratio: number;
}

function buildComment(t: InferenceRecord): string {
  const parts: string[] = [];
  const totalIn =
    t.raw_input_tokens + t.cache_read_tokens + t.cache_creation_tokens;

  if (totalIn > 0) {
    const hitRatio = t.cache_read_tokens / totalIn;
    if (t.cache_creation_tokens > 5000 && t.cache_read_tokens < 1000) {
      parts.push("first inference / cache miss — paying to fill cache");
    } else if (hitRatio > 0.9) {
      parts.push(`cache fully warm (${Math.round(hitRatio * 100)}% reads)`);
    } else if (hitRatio < 0.3 && t.cache_creation_tokens > 1000) {
      parts.push("context grew — partial cache write");
    }
  }

  if (t.thinking_blocks > 0 && t.output_tokens > 2000) {
    parts.push(`reasoning-heavy (${t.thinking_blocks} thinking blocks)`);
  } else if (t.tool_use_blocks > 0 && t.text_blocks === 0) {
    parts.push(`tool-only inference (${t.tool_use_blocks} calls, no text reply)`);
  } else if (t.tool_use_blocks === 0 && t.thinking_blocks === 0) {
    parts.push("plain text reply");
  }

  const editCount = t.tools_used.filter((n) => EDIT_TOOLS.has(n)).length;
  const readCount = t.tools_used.filter((n) => READ_TOOLS.has(n)).length;
  if (editCount > 0 && t.output_tokens > 1000) {
    parts.push("output dominated by file content");
  } else if (readCount >= 3) {
    parts.push("research-heavy inference");
  }

  return parts.length ? parts.join(" · ") : "—";
}

export function analyzeInferences(t: Transcript): InferenceAnalysis {
  const inferences: LoggedInference[] = t.inferences.map((inf) => ({
    ...inf,
    session_id: t.session_id,
    ts: inf.ts,
    comment: buildComment(inf),
  }));

  const totals = inferences.reduce(
    (acc, inf) => ({
      raw_input_tokens: acc.raw_input_tokens + inf.raw_input_tokens,
      cache_read_tokens: acc.cache_read_tokens + inf.cache_read_tokens,
      cache_creation_tokens:
        acc.cache_creation_tokens + inf.cache_creation_tokens,
      output_tokens: acc.output_tokens + inf.output_tokens,
    }),
    {
      raw_input_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      output_tokens: 0,
    },
  );

  const by_tool: InferenceAnalysis["by_tool"] = {};
  for (const inf of inferences) {
    const seen = new Set<string>();
    for (const name of inf.tools_used) {
      by_tool[name] ??= { calls: 0, inferences_with_tool: 0 };
      by_tool[name].calls += 1;
      if (!seen.has(name)) {
        by_tool[name].inferences_with_tool += 1;
        seen.add(name);
      }
    }
  }

  const totalIn =
    totals.raw_input_tokens +
    totals.cache_read_tokens +
    totals.cache_creation_tokens;
  const cache_hit_ratio =
    totalIn > 0 ? totals.cache_read_tokens / totalIn : 0;

  return {
    session_id: t.session_id,
    model: t.model,
    total_inferences: inferences.length,
    inferences,
    totals,
    by_tool,
    cache_hit_ratio,
  };
}

function readPersistedRows(): string[] {
  const path = persistedPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

export function logInferences(
  inferences: LoggedInference[],
): { logged: number; path: string } {
  ensureDir();
  const displayPath = "~/.compute-finance/inferences.jsonl";
  if (inferences.length === 0) {
    return { logged: 0, path: displayPath };
  }
  const sid = inferences[0].session_id;
  const kept: string[] = [];
  for (const line of readPersistedRows()) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.session_id === sid) continue;
    kept.push(line);
  }
  const fresh = inferences.map((inf) => JSON.stringify(inf));
  const body = [...kept, ...fresh].join("\n") + "\n";
  const target = persistedPath();
  const tmp = target + ".tmp";
  writeFileSync(tmp, body);
  renameSync(tmp, target);
  return { logged: inferences.length, path: displayPath };
}

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UsageTotals {
  session_id: string;
  session_path: string;
  cwd: string;
  model: string | null;
  turns: number;
  tool_calls: number;
  edits: number;
  reads: number;
  extended_thinking_used: boolean;
  raw_input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  first_ts: string | null;
  last_ts: string | null;
}

import {
  EDIT_TOOLS,
  READ_TOOLS,
  isHumanUserTurn,
  encodeCwd,
  isValidSessionId,
} from "./tools.js";

function projectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function findSessionFile(session_id: string, cwd?: string): string | null {
  if (!isValidSessionId(session_id)) return null;
  const root = projectsDir();
  if (!existsSync(root)) return null;
  if (cwd) {
    const candidate = join(root, encodeCwd(cwd), `${session_id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  for (const proj of readdirSync(root)) {
    const candidate = join(root, proj, `${session_id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function findLatestSessionFile(cwd?: string): string | null {
  const root = projectsDir();
  if (!existsSync(root)) return null;
  const dirs = cwd ? [encodeCwd(cwd)] : readdirSync(root);
  let best: { path: string; mtime: number } | null = null;
  for (const d of dirs) {
    const full = join(root, d);
    if (!existsSync(full)) continue;
    for (const f of readdirSync(full)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(full, f);
      const m = statSync(p).mtimeMs;
      if (!best || m > best.mtime) best = { path: p, mtime: m };
    }
  }
  return best?.path ?? null;
}

export function parseSessionUsage(path: string): UsageTotals {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const norm = path.replace(/\\/g, "/");
  const cwdMatch = norm.match(/projects\/(-[^/]+)\//);
  const cwd = cwdMatch ? "/" + cwdMatch[1].slice(1).replace(/-/g, "/") : "";
  const session_id = norm.split("/").pop()!.replace(/\.jsonl$/, "");

  const totals: UsageTotals = {
    session_id,
    session_path: path,
    cwd,
    model: null,
    turns: 0,
    tool_calls: 0,
    edits: 0,
    reads: 0,
    extended_thinking_used: false,
    raw_input_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 0,
    first_ts: null,
    last_ts: null,
  };

  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = rec.timestamp;
    if (ts) {
      if (!totals.first_ts) totals.first_ts = ts;
      totals.last_ts = ts;
    }
    if (isHumanUserTurn(rec)) totals.turns += 1;
    if (rec.type !== "assistant") continue;

    const msg = rec.message;
    if (!msg) continue;
    if (msg.model && !totals.model) totals.model = msg.model;

    const usage = msg.usage;
    if (usage) {
      totals.raw_input_tokens += usage.input_tokens ?? 0;
      totals.cache_creation_tokens += usage.cache_creation_input_tokens ?? 0;
      totals.cache_read_tokens += usage.cache_read_input_tokens ?? 0;
      totals.output_tokens += usage.output_tokens ?? 0;
    }

    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_use") {
          totals.tool_calls += 1;
          if (EDIT_TOOLS.has(block.name)) totals.edits += 1;
          if (READ_TOOLS.has(block.name)) totals.reads += 1;
        }
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          totals.extended_thinking_used = true;
        }
      }
    }
  }

  return totals;
}

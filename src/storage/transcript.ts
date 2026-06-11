import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  encodeCwd,
  isHumanPrompt,
  isValidSessionId,
  numberField,
} from "./tools.js";

export interface PromptRecord {
  index: number;
  ts: string | null;
}

export interface InferenceRecord {
  index: number;
  prompt_index: number | null;
  ts: string | null;
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
}

export interface Transcript {
  session_id: string;
  session_path: string;
  cwd: string;
  model: string | null;
  first_ts: string | null;
  last_ts: string | null;
  prompts: PromptRecord[];
  inferences: InferenceRecord[];
}

function projectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function findSessionFile(
  session_id: string,
  cwd?: string,
): string | null {
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
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    for (const f of readdirSync(full)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(full, f);
      const m = statSync(p).mtimeMs;
      if (!best || m > best.mtime) best = { path: p, mtime: m };
    }
  }
  return best?.path ?? null;
}

export function parseTranscript(path: string): Transcript {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const norm = path.replace(/\\/g, "/");
  const cwdMatch = norm.match(/projects\/(-[^/]+)\//);
  const cwd = cwdMatch ? "/" + cwdMatch[1].slice(1).replace(/-/g, "/") : "";
  const session_id = norm.split("/").pop()!.replace(/\.jsonl$/, "");

  const prompts: PromptRecord[] = [];
  const inferences: InferenceRecord[] = [];
  let currentModel: string | null = null;
  let first_ts: string | null = null;
  let last_ts: string | null = null;
  let lastPromptTs: string | null = null;
  let lastPromptIndex: number | null = null;

  for (const line of lines) {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const r = rec as Record<string, unknown>;
    const ts = typeof r.timestamp === "string" ? r.timestamp : null;
    if (ts) {
      if (!first_ts) first_ts = ts;
      last_ts = ts;
    }

    if (r.type === "user") {
      if (!isHumanPrompt(r)) continue;
      const index = prompts.length;
      prompts.push({ index, ts });
      lastPromptTs = ts;
      lastPromptIndex = index;
      continue;
    }

    if (r.type !== "assistant") continue;

    const msg = r.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const modelField = typeof msg.model === "string" ? msg.model : null;
    if (modelField) currentModel = modelField;

    const usage = (msg.usage ?? {}) as Record<string, unknown>;
    const content = Array.isArray(msg.content)
      ? (msg.content as Array<Record<string, unknown>>)
      : [];

    let thinking_blocks = 0;
    let text_blocks = 0;
    let tool_use_blocks = 0;
    const tools_used: string[] = [];
    for (const block of content) {
      const bt = block.type;
      if (bt === "thinking" || bt === "redacted_thinking") thinking_blocks += 1;
      else if (bt === "text") text_blocks += 1;
      else if (bt === "tool_use") {
        tool_use_blocks += 1;
        if (typeof block.name === "string") tools_used.push(block.name);
      }
    }

    let duration_ms: number | null = null;
    if (lastPromptTs && ts) {
      const d = new Date(ts).getTime() - new Date(lastPromptTs).getTime();
      duration_ms = d >= 0 ? d : null;
    }

    inferences.push({
      index: inferences.length,
      prompt_index: lastPromptIndex,
      ts,
      model: currentModel,
      raw_input_tokens: numberField(usage.input_tokens),
      cache_read_tokens: numberField(usage.cache_read_input_tokens),
      cache_creation_tokens: numberField(usage.cache_creation_input_tokens),
      output_tokens: numberField(usage.output_tokens),
      thinking_blocks,
      text_blocks,
      tool_use_blocks,
      tools_used,
      duration_ms,
    });
  }

  return {
    session_id,
    session_path: path,
    cwd,
    model: currentModel,
    first_ts,
    last_ts,
    prompts,
    inferences,
  };
}


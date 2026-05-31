// Three orthogonal counts derived from a Transcript. All reports read this
// projection so their header triplet is identical by construction.

import { EDIT_TOOLS, READ_TOOLS } from "./tools.js";
import {
  parseTranscript,
  findSessionFile,
  findLatestSessionFile,
  Transcript,
} from "./transcript.js";

export interface UsageTotals {
  session_id: string;
  session_path: string;
  cwd: string;
  model: string | null;
  prompts: number;
  inferences: number;
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

export function summarizeSession(t: Transcript): UsageTotals {
  let tool_calls = 0;
  let edits = 0;
  let reads = 0;
  let extended_thinking_used = false;
  let raw_input_tokens = 0;
  let cache_creation_tokens = 0;
  let cache_read_tokens = 0;
  let output_tokens = 0;

  for (const inf of t.inferences) {
    raw_input_tokens += inf.raw_input_tokens;
    cache_creation_tokens += inf.cache_creation_tokens;
    cache_read_tokens += inf.cache_read_tokens;
    output_tokens += inf.output_tokens;
    if (inf.thinking_blocks > 0) extended_thinking_used = true;
    for (const name of inf.tools_used) {
      tool_calls += 1;
      if (EDIT_TOOLS.has(name)) edits += 1;
      if (READ_TOOLS.has(name)) reads += 1;
    }
  }

  return {
    session_id: t.session_id,
    session_path: t.session_path,
    cwd: t.cwd,
    model: t.model,
    prompts: t.prompts.length,
    inferences: t.inferences.length,
    tool_calls,
    edits,
    reads,
    extended_thinking_used,
    raw_input_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    output_tokens,
    first_ts: t.first_ts,
    last_ts: t.last_ts,
  };
}

export function parseSessionUsage(path: string): UsageTotals {
  return summarizeSession(parseTranscript(path));
}

export { findSessionFile, findLatestSessionFile };

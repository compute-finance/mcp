// Session profile classification. Shape signal, not a capability claim.
// Used by both render_session_report and analyze_session so the thresholds
// live in one place.

export interface ProfileSignals {
  edits: number;
  reads: number;
  tool_calls: number;
  extended_thinking: boolean;
}

export interface ProfileResult {
  profile: "reasoning-heavy" | "edit-heavy" | "research-heavy" | "mixed";
  out_in_ratio: number;
  signals: ProfileSignals;
}

export interface ProfileInput {
  tool_calls: number;
  edits: number;
  reads: number;
  extended_thinking_used: boolean;
  raw_input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
}

export function classifyProfile(u: ProfileInput): ProfileResult {
  // out_in_ratio reflects session SHAPE, not cost: settled context only
  // (raw_input + cache_read), excluding cache_creation. Cost math is separate —
  // see effectiveCost in oracle/pricing.ts.
  const totalIn = u.raw_input_tokens + u.cache_read_tokens;
  const out_in_ratio = totalIn > 0 ? u.output_tokens / totalIn : 0;
  const editRatio = u.tool_calls > 0 ? u.edits / u.tool_calls : 0;
  const readRatio = u.tool_calls > 0 ? u.reads / u.tool_calls : 0;
  let profile: ProfileResult["profile"] = "mixed";
  if (u.extended_thinking_used && out_in_ratio > 0.3 && editRatio < 0.3) {
    profile = "reasoning-heavy";
  } else if (editRatio > 0.4) {
    profile = "edit-heavy";
  } else if (readRatio > 0.5 && u.edits < 3) {
    profile = "research-heavy";
  }
  return {
    profile,
    out_in_ratio: Math.round(out_in_ratio * 1000) / 1000,
    signals: {
      edits: u.edits,
      reads: u.reads,
      tool_calls: u.tool_calls,
      extended_thinking: u.extended_thinking_used,
    },
  };
}

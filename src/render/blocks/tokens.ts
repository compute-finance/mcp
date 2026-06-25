import { tokens } from "../format.js";

export interface TokenCounts {
  raw_input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
}

export function tokensSplit(t: TokenCounts): string {
  return `${tokens(t.raw_input_tokens)} fresh · ${tokens(t.cache_read_tokens)} cache-read · ${tokens(t.cache_creation_tokens)} cache-write · ${tokens(t.output_tokens)} output`;
}

export function tokensFootprint(
  t: TokenCounts,
  inferences: number,
): string | null {
  if (inferences <= 0 || t.cache_read_tokens <= 0) return null;
  const context = t.cache_read_tokens / inferences;
  const legacyTotal =
    t.raw_input_tokens +
    t.cache_read_tokens +
    t.cache_creation_tokens +
    t.output_tokens;
  return `≈ ${tokens(context)} context, re-read ×${inferences} (not ${tokens(legacyTotal)} of unique work)`;
}

const TOKENS_PREFIX = "Tokens: ";
const FOOTPRINT_INDENT = " ".repeat(TOKENS_PREFIX.length);

export function renderTokensBlock(
  t: TokenCounts,
  inferences: number,
): string[] {
  const lines = [`${TOKENS_PREFIX}${tokensSplit(t)}`];
  const footprint = tokensFootprint(t, inferences);
  if (footprint !== null) lines.push(`${FOOTPRINT_INDENT}${footprint}`);
  return lines;
}

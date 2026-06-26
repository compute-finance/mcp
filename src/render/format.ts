export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  // Sub-dollar amounts keep 4 decimals — per-inference costs need cent precision.
  if (Math.abs(n) < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// Humanise a duration — ms under 1s, seconds with one decimal under a minute,
// m+s past a minute. A 30-second Bash call reads as `30.0s` not `30000ms`.
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function pad(s: string, width: number, align: "l" | "r" = "l"): string {
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return align === "l" ? s + fill : fill + s;
}

export function bar(value: number, max: number, width = 20, glyph = "█"): string {
  if (max <= 0) return "".padEnd(width, "·");
  const n = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return glyph.repeat(n).padEnd(width, "·");
}

export function line(s: string): string {
  return s.replace(/\s+$/, "");
}

export function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

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

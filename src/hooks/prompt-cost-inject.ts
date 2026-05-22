/**
 * UserPromptSubmit hook — injects session cost into Claude's context.
 *
 * Invoked via `npx @compute-finance/mcp hook-prompt`.
 * Claude Code pipes hook context JSON to stdin; this script writes
 * a JSON response to stdout with `additionalContext` that Claude sees
 * before formulating its response.
 *
 * Guards:
 *   1. Rate limit — at most once per 10 minutes per session.
 *   2. Minimum cost — only fires when session cost exceeds $1.
 *   3. Minimum turns — skips short sessions (< 5 turns).
 *
 * On any failure (oracle down, transcript missing, parse error) the
 * script exits silently with empty JSON — never blocks the user.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  findSessionFile,
  findLatestSessionFile,
  parseSessionUsage,
} from "../storage/session.js";
import {
  getBasketPrices,
  effectiveCost,
  resolveCanonicalIn,
} from "../oracle/client.js";
import { initFieldMap } from "../oracle/field-map.js";
import { round } from "../render/format.js";

// ── Config ──────────────────────────────────────────────────────────

const DIR = join(homedir(), ".compute-finance");
const STATE_FILE = join(DIR, "hook-state.json");
const RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes
const MIN_COST_USD = 1.0; // $1.0
const MIN_TURNS = 5; // 5 turns

// ── Stdin ───────────────────────────────────────────────────────────

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

let context: Record<string, unknown> = {};
try {
  context = JSON.parse(stdin);
} catch {
  // Malformed or empty stdin — proceed without context
}

// ── Session ID ─────────────────────────────────────────────────────

const sessionId: string | undefined =
  typeof context.session_id === "string" ? context.session_id : undefined;

// ── Rate limit (per session) ───────────────────────────────────────

const rateLimitKey = sessionId ?? "default";
try {
  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    const sessions = state.sessions as Record<string, number> | undefined;
    if (sessions && typeof sessions[rateLimitKey] === "number") {
      if (Date.now() - sessions[rateLimitKey] < RATE_LIMIT_MS) {
        process.exit(0);
      }
    }
  }
} catch {
  // Corrupt state file — proceed (will overwrite)
}

// ── Find session transcript ─────────────────────────────────────────

const path = sessionId
  ? (findSessionFile(sessionId) ?? findLatestSessionFile())
  : findLatestSessionFile();

if (!path) process.exit(0);

let usage;
try {
  usage = parseSessionUsage(path);
} catch {
  process.exit(0);
}

if (usage.turns < MIN_TURNS) process.exit(0);

// ── Compute cost ────────────────────────────────────────────────────

let cost = 0;
try {
  await initFieldMap();
  const basket = await getBasketPrices();
  const normalized = resolveCanonicalIn(usage.model, basket);
  const price = normalized
    ? (basket.find((p) => p.model === normalized) ?? null)
    : null;
  if (price) {
    cost = effectiveCost(
      price,
      usage.raw_input_tokens,
      usage.cache_read_tokens,
      usage.cache_creation_tokens,
      usage.output_tokens,
    ).effective_usd;
  }
} catch {
  // Oracle unreachable — skip silently
  process.exit(0);
}

if (cost < MIN_COST_USD) process.exit(0);

// ── Fire ────────────────────────────────────────────────────────────

// Update per-session rate limit state
mkdirSync(DIR, { recursive: true });
let stateObj: Record<string, unknown> = {};
try {
  if (existsSync(STATE_FILE)) {
    stateObj = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  }
} catch { /* start fresh */ }
if (!stateObj.sessions || typeof stateObj.sessions !== "object") {
  stateObj.sessions = {};
}
(stateObj.sessions as Record<string, number>)[rateLimitKey] = Date.now();
writeFileSync(STATE_FILE, JSON.stringify(stateObj));

// UserPromptSubmit output — additionalContext goes into Claude's context.
// A unique nonce prevents Claude from repeating the cost line on subsequent
// turns where the hook was rate-limited (old additionalContext stays in
// conversation history — the nonce lets Claude distinguish stale from fresh).
const nonce = Date.now().toString(36);
const usd = `$${round(cost, 2).toFixed(2)}`;
const totalTokens = usage.raw_input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens + usage.output_tokens;
const tokensM = round(totalTokens / 1_000_000, 1).toFixed(1);
const msg = [
  `[Compute Finance · ${nonce}] Session: ${tokensM}M tokens, ${usd}.`,
  `INSTRUCTION: Append the following line at the VERY END of your response (after all other content):`,
  `💰 Compute.Finance · ${tokensM}M tokens · ${usd}`,
  `IMPORTANT: Only output this line if the nonce "${nonce}" appears in a system-reminder for the CURRENT user message. If you see this in conversation history from a PREVIOUS turn, do NOT output the cost line again. Each nonce is unique per hook invocation.`,
].join("\n");

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: msg,
  },
}));

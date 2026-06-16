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
  priceSession,
  resolveCanonicalIn,
} from "../oracle/client.js";
import { initFieldMap } from "../oracle/field-map.js";
import { round } from "../render/format.js";

const DIR = join(homedir(), ".compute-finance");
const STATE_FILE = join(DIR, "hook-state.json");
const RATE_LIMIT_MS = 10 * 60 * 1000;
const MIN_COST_USD = 1.0;
const MIN_PROMPTS = 5;

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

let context: Record<string, unknown> = {};
try {
  context = JSON.parse(stdin);
} catch { /* malformed stdin — proceed without context */ }

const sessionId: string | undefined =
  typeof context.session_id === "string" ? context.session_id : undefined;

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
} catch { /* corrupt state file — proceed, will overwrite */ }

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

if (usage.prompts < MIN_PROMPTS) process.exit(0);

let cost = 0;
try {
  await initFieldMap();
  const basket = await getBasketPrices();
  const normalized = resolveCanonicalIn(usage.model, basket);
  const price = normalized
    ? (basket.find((p) => p.model === normalized) ?? null)
    : null;
  if (price) {
    const r = priceSession(
      price,
      usage.raw_input_tokens,
      usage.cache_read_tokens,
      usage.cache_creation_tokens,
      usage.output_tokens,
    );
    if (!r.effective) process.exit(0);
    cost = r.effective.effective_usd;
  }
} catch {
  process.exit(0);
}

if (cost < MIN_COST_USD) process.exit(0);

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

// Nonce prevents Claude from repeating the cost line on rate-limited prompts where old additionalContext lingers in history.
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

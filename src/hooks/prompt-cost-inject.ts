import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  findSessionFile,
  findLatestSessionFile,
  parseSessionUsage,
  UsageTotals,
} from "../storage/session.js";
import {
  getBasketPrices,
  getScu,
  priceSession,
  resolveCanonicalIn,
} from "../oracle/client.js";
import { initFieldMap } from "../oracle/field-map.js";
import { classifyProfile } from "../storage/profile.js";
import { logSession } from "../storage/history.js";
import { detectSubscription } from "../storage/subscription.js";
import { composeHookLine, HookComposeInputs } from "./compose.js";

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
} catch {
  /* malformed stdin — proceed without context */
}

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
} catch {
  /* corrupt state file — proceed, will overwrite */
}

const path = sessionId
  ? (findSessionFile(sessionId) ?? findLatestSessionFile())
  : findLatestSessionFile();

if (!path) process.exit(0);

let usage: UsageTotals;
try {
  usage = parseSessionUsage(path);
} catch {
  process.exit(0);
}

if (usage.prompts < MIN_PROMPTS) process.exit(0);

let composeInputs: HookComposeInputs | null = null;
let effective_usd: number | null = null;
let nominal_usd: number | null = null;
let normalized: string | null = null;

try {
  await initFieldMap();
  const basket = await getBasketPrices();
  normalized = resolveCanonicalIn(usage.model, basket);
  const subscription = detectSubscription().isSubscription;

  if (normalized) {
    const price = basket.find((p) => p.model === normalized) ?? null;
    if (!price) process.exit(0);
    const r = priceSession(
      price,
      usage.raw_input_tokens,
      usage.cache_read_tokens,
      usage.cache_creation_tokens,
      usage.output_tokens,
    );
    if (!r.effective) process.exit(0);
    effective_usd = r.effective.effective_usd;
    nominal_usd = r.nominal_usd;
    if (effective_usd < MIN_COST_USD) process.exit(0);

    const scu = (await getScu()) as Record<string, unknown> | null;
    const scuUsdRaw = scu?.scuUsd;
    const scu_usd =
      typeof scuUsdRaw === "number"
        ? scuUsdRaw
        : typeof scuUsdRaw === "string"
          ? Number(scuUsdRaw)
          : NaN;
    if (!Number.isFinite(scu_usd) || scu_usd <= 0) process.exit(0);

    composeInputs = {
      mode: "basket",
      effective_usd,
      nominal_usd,
      scu_usd,
      subscription,
    };
  } else {
    composeInputs = {
      mode: "off_basket",
      fresh_tokens:
        usage.raw_input_tokens +
        usage.cache_creation_tokens +
        usage.output_tokens,
      cached_tokens: usage.cache_read_tokens,
      cost_usd: null,
      subscription,
    };
  }
} catch {
  process.exit(0);
}

if (!composeInputs) process.exit(0);

mkdirSync(DIR, { recursive: true });
let stateObj: Record<string, unknown> = {};
try {
  if (existsSync(STATE_FILE)) {
    stateObj = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  }
} catch {
  /* start fresh */
}
if (!stateObj.sessions || typeof stateObj.sessions !== "object") {
  stateObj.sessions = {};
}
(stateObj.sessions as Record<string, number>)[rateLimitKey] = Date.now();
try {
  writeFileSync(STATE_FILE, JSON.stringify(stateObj));
} catch {
  /* best-effort rate-limit persistence */
}

try {
  const { profile, out_in_ratio } = classifyProfile(usage);
  logSession({
    session_id: usage.session_id,
    model: normalized,
    in_basket: normalized !== null,
    profile,
    raw_input_tokens: usage.raw_input_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    output_tokens: usage.output_tokens,
    prompts: usage.prompts,
    inferences: usage.inferences,
    tool_calls: usage.tool_calls,
    edits: usage.edits,
    reads: usage.reads,
    extended_thinking_used: usage.extended_thinking_used,
    effective_usd,
    nominal_usd,
    out_in_ratio,
  });
} catch {
  /* history write is best-effort */
}

const line = composeHookLine(composeInputs);
const nonce = Date.now().toString(36);
const msg = [
  `[Compute Finance · ${nonce}] Session: ${line}`,
  `INSTRUCTION: Append the following line at the VERY END of your response (after all other content):`,
  line,
  `IMPORTANT: Only output this line if the nonce "${nonce}" appears in a system-reminder for the CURRENT user message. If you see this in conversation history from a PREVIOUS turn, do NOT output the cost line again. Each nonce is unique per hook invocation.`,
].join("\n");

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: msg,
    },
  }),
);

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelPrice } from "../oracle/types.js";
import { effectiveCost } from "../oracle/client.js";

const DIR = join(homedir(), ".compute-finance");
const SESSIONS = join(DIR, "sessions.jsonl");

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export interface SessionRecord {
  session_id: string;
  ts: string;
  model: string | null;
  in_basket: boolean;
  profile: string;
  raw_input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  prompts: number;
  inferences: number;
  tool_calls: number;
  edits: number;
  reads: number;
  extended_thinking_used: boolean;
  effective_usd: number | null;
  nominal_usd: number | null;
  out_in_ratio: number;
}

export function logSession(rec: Omit<SessionRecord, "ts">): SessionRecord {
  ensureDir();
  const full: SessionRecord = { ...rec, ts: new Date().toISOString() };
  appendFileSync(SESSIONS, JSON.stringify(full) + "\n");
  return full;
}

export function readHistoryRaw(): SessionRecord[] {
  if (!existsSync(SESSIONS)) return [];
  const lines = readFileSync(SESSIONS, "utf8").split("\n").filter(Boolean);
  // Skip corrupt lines silently. Append-only log can tear on crash mid-write;
  // one bad line must not take out getStats for the rest of the file.
  const out: SessionRecord[] = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l) as SessionRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}

// Dedupe by session_id, last-wins. Re-running the skill on the same session
// must NOT double-count into cumulative totals or insight evidence.
export function readHistory(): SessionRecord[] {
  const raw = readHistoryRaw();
  const byId = new Map<string, SessionRecord>();
  for (const r of raw) byId.set(r.session_id, r);
  return Array.from(byId.values());
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface HistoryStats {
  sample_size: number;
  distinct_sessions: number;
  by_profile: Record<
    string,
    {
      n: number;
      median_total_input: number;
      median_output: number;
      median_effective_usd: number;
    }
  >;
  cumulative_effective_usd: number;
  cumulative_nominal_usd: number;
  insights: Insight[];
}

export interface Insight {
  kind: "frontier_underused" | "cache_dominance";
  message: string;
  evidence: Record<string, unknown>;
}

// Given a frontier model used in a session, find the cheapest same-provider
// non-frontier alternative in the live basket. Pure data lookup — no
// provider-specific branches.
function cheaperAlternative(
  model: string,
  basket: ModelPrice[],
): ModelPrice | null {
  const current = basket.find((p) => p.model === model);
  if (!current) return null;
  const candidates = basket.filter(
    (p) =>
      p.provider === current.provider &&
      p.tier !== "frontier" &&
      p.model !== current.model,
  );
  if (candidates.length === 0) return null;
  // Cheapest by input+output combined (workload-neutral ranking).
  return [...candidates].sort(
    (a, b) =>
      a.input_usd_per_million +
      a.output_usd_per_million -
      (b.input_usd_per_million + b.output_usd_per_million),
  )[0];
}

function computeInsights(
  recs: SessionRecord[],
  basket: ModelPrice[],
): Insight[] {
  const out: Insight[] = [];
  if (recs.length < 5) return out;

  const frontierSet = new Set(
    basket.filter((p) => p.tier === "frontier").map((p) => p.model),
  );

  // 1. Frontier underused: sessions on a frontier model, profile=edit/research,
  //    no extended thinking → counterfactual on cheapest same-provider alt.
  const underused = recs.filter(
    (r) =>
      r.model &&
      frontierSet.has(r.model) &&
      (r.profile === "edit-heavy" || r.profile === "research-heavy") &&
      !r.extended_thinking_used,
  );
  if (underused.length >= 3) {
    let totalSaved = 0;
    const altsSeen = new Set<string>();
    for (const r of underused) {
      const alt = cheaperAlternative(r.model!, basket);
      const current = basket.find((p) => p.model === r.model);
      if (!alt || !current) continue;
      altsSeen.add(alt.model);
      const currentEff = effectiveCost(
        current,
        r.raw_input_tokens,
        r.cache_read_tokens,
        r.cache_creation_tokens,
        r.output_tokens,
      ).effective_usd;
      const altEff = effectiveCost(
        alt,
        r.raw_input_tokens,
        r.cache_read_tokens,
        r.cache_creation_tokens,
        r.output_tokens,
      ).effective_usd;
      totalSaved += Math.max(0, currentEff - altEff);
    }
    if (totalSaved > 0) {
      const altList = Array.from(altsSeen).join(", ");
      out.push({
        kind: "frontier_underused",
        message: `${underused.length} of your last ${recs.length} sessions were edit- or research-heavy on a frontier model without extended thinking. Same-provider standard tier (${altList}) would have saved ~$${totalSaved.toFixed(2)} cumulative at current oracle prices.`,
        evidence: {
          sample: recs.length,
          matches: underused.length,
          models_seen: Array.from(new Set(underused.map((r) => r.model))),
          alternatives: Array.from(altsSeen),
          est_cumulative_savings_usd: Math.round(totalSaved * 100) / 100,
        },
      });
    }
  }

  // 2. Cache dominance: median cache_read ratio > 90% of input tokens.
  const withCache = recs.filter(
    (r) => r.raw_input_tokens + r.cache_read_tokens > 0,
  );
  if (withCache.length >= 5) {
    const ratios = withCache.map(
      (r) => r.cache_read_tokens / (r.raw_input_tokens + r.cache_read_tokens),
    );
    const medRatio = median(ratios);
    if (medRatio > 0.9) {
      const totalSaved = withCache.reduce(
        (acc, r) => acc + ((r.nominal_usd ?? 0) - (r.effective_usd ?? 0)),
        0,
      );
      out.push({
        kind: "cache_dominance",
        message: `${Math.round(medRatio * 100)}% of your input tokens are cache reads. Prompt caching has saved you ~$${totalSaved.toFixed(2)} cumulative vs nominal pricing.`,
        evidence: {
          sample: withCache.length,
          median_cache_ratio: Math.round(medRatio * 1000) / 1000,
          cumulative_cache_savings_usd: Math.round(totalSaved * 100) / 100,
        },
      });
    }
  }

  return out;
}

export async function getStats(basket: ModelPrice[]): Promise<HistoryStats> {
  const recs = readHistory();
  const seen = new Set(recs.map((r) => r.session_id));
  const byProfile: Record<string, SessionRecord[]> = {};
  for (const r of recs) (byProfile[r.profile] ??= []).push(r);
  const by_profile: HistoryStats["by_profile"] = {};
  for (const [p, rs] of Object.entries(byProfile)) {
    by_profile[p] = {
      n: rs.length,
      median_total_input: Math.round(
        median(rs.map((r) => r.raw_input_tokens + r.cache_read_tokens)),
      ),
      median_output: Math.round(median(rs.map((r) => r.output_tokens))),
      median_effective_usd:
        Math.round(median(rs.map((r) => r.effective_usd ?? 0)) * 1e4) / 1e4,
    };
  }
  return {
    sample_size: recs.length,
    distinct_sessions: seen.size,
    by_profile,
    cumulative_effective_usd:
      Math.round(recs.reduce((a, r) => a + (r.effective_usd ?? 0), 0) * 1e4) / 1e4,
    cumulative_nominal_usd:
      Math.round(recs.reduce((a, r) => a + (r.nominal_usd ?? 0), 0) * 1e4) / 1e4,
    insights: computeInsights(recs, basket),
  };
}

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelPrice } from "../oracle/types.js";

function storageDir(): string {
  return process.env.COMPUTE_FINANCE_DIR ?? join(homedir(), ".compute-finance");
}

function sessionsPath(): string {
  return join(storageDir(), "sessions.jsonl");
}

function ensureDir() {
  const dir = storageDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
  appendFileSync(sessionsPath(), JSON.stringify(full) + "\n");
  return full;
}

export function readHistoryRaw(): SessionRecord[] {
  if (!existsSync(sessionsPath())) return [];
  const lines = readFileSync(sessionsPath(), "utf8").split("\n").filter(Boolean);
  // Append-only log can tear on crash mid-write — skip bad lines so getStats survives.
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

// Last-wins dedupe — re-running the skill on the same session must not double-count.
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
  kind: "cache_dominance";
  message: string;
  evidence: Record<string, unknown>;
}

function computeInsights(
  recs: SessionRecord[],
  basket: ModelPrice[],
): Insight[] {
  const out: Insight[] = [];
  if (recs.length < 5) return out;

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

export async function getStats(
  basket: ModelPrice[],
  excludeSessionId?: string,
): Promise<HistoryStats> {
  const all = readHistory();
  const recs = excludeSessionId
    ? all.filter((r) => r.session_id !== excludeSessionId)
    : all;
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

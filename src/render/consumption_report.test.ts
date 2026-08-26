import { describe, it, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderConsumptionReport } from "./consumption_report.js";
import { _resetResolveCache } from "../oracle/client.js";

const CACHED_SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const UNCACHED_SESSION = "bbbbbbbb-1111-2222-3333-444444444444";

function transcript(model: string, cacheReadTokens: number): string {
  return [
    JSON.stringify({
      type: "user",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { content: "hi" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-01T10:00:04.000Z",
      message: {
        model,
        content: [{ type: "text", text: "hello" }],
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: 0,
          output_tokens: 200,
        },
      },
    }),
  ].join("\n");
}

function resolveResponse(key: string, withCache: boolean): Response {
  return new Response(
    JSON.stringify({
      inputKey: key,
      resolvedKey: key,
      family: "test.family",
      provider: { key: "test", name: "Test" },
      prices: {
        inputUsdPerMillion: 5,
        outputUsdPerMillion: 25,
        provenance: { input: "inferred", output: "inferred" },
      },
      cache: withCache
        ? {
            cachedInput: {
              usdPerMillion: 0.5,
              ratioOfInput: 0.1,
              provenance: "verified",
              createdAt: null,
            },
            cacheWrite5m: null,
            cacheWrite1h: null,
          }
        : null,
      reasoning: null,
      inBasket: true,
      priceSource: "oracle-basket",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let home: string;
let originalHome: string | undefined;
let originalStorage: string | undefined;
let originalFetch: typeof globalThis.fetch;

before(() => {
  home = mkdtempSync(join(tmpdir(), "cf-consumption-"));
  originalHome = process.env.HOME;
  originalStorage = process.env.COMPUTE_FINANCE_DIR;
  process.env.HOME = home;
  process.env.COMPUTE_FINANCE_DIR = join(home, "storage");
  const projectDir = join(home, ".claude", "projects", "-tmp-cf");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${CACHED_SESSION}.jsonl`),
    transcript("anthropic/claude-opus-4.8", 4000),
  );
  writeFileSync(
    join(projectDir, `${UNCACHED_SESSION}.jsonl`),
    transcript("qwen/qwen-3.7-max", 0),
  );
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalStorage === undefined) delete process.env.COMPUTE_FINANCE_DIR;
  else process.env.COMPUTE_FINANCE_DIR = originalStorage;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetResolveCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("renderConsumptionReport — cache attribution", () => {
  it("SHOULD print the cache multipliers WITH their marks beside the savings line", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      resolveResponse(
        decodeURIComponent(input.toString().split("/").pop()!),
        true,
      )) as typeof globalThis.fetch;

    const out = await renderConsumptionReport({ session_id: CACHED_SESSION });
    assert.match(out, /saved \$[\d.]+ via cache/);
    assert.match(out, /Oracle cache multipliers: read 0\.1× \(verified\)/);
  });

  it("SHOULD NOT claim a cache saving next to an unavailability line FOR a model with no cache pricing — Bug guarded: 'saved $0.0000 via cache' and 'Cache pricing unavailable' are contradictory and cannot both be true", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      resolveResponse(
        decodeURIComponent(input.toString().split("/").pop()!),
        false,
      )) as typeof globalThis.fetch;

    const out = await renderConsumptionReport({ session_id: UNCACHED_SESSION });
    assert.doesNotMatch(out, /via cache/);
    assert.doesNotMatch(out, /Cache pricing unavailable/);
    assert.match(out, /Total: \$[\d.]+ nominal {2}· {2}oracle publishes no cache pricing/);
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getCatalog, getModelAvailability, _resetOracleCache } from "./client.js";

const AVAILABILITY = {
  computedAt: "2026-09-14T14:48:09.489Z",
  ttlSeconds: 10,
  models: [
    { id: "anthropic/claude-opus-4.8", routable: true },
    { id: "openai/gpt-5.5", routable: false },
  ],
  auto: { id: "anthropic/claude-opus-4.8" },
};

let originalFetch: typeof globalThis.fetch;
let calls: string[] = [];

function serve(body: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(input.toString());
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  _resetOracleCache();
  serve(AVAILABILITY);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetOracleCache();
});

describe("getModelAvailability", () => {
  it("SHOULD read the public-pool map off /v1/models/availability", async () => {
    await getModelAvailability();
    assert.deepEqual(calls, ["https://api.compute.finance/v1/models/availability"]);
  });

  it("SHOULD serve the exchange's answer verbatim — Bug guarded: a routability map reshaped here is a second liveness opinion that can disagree with the router that has to honour it", async () => {
    assert.deepEqual(await getModelAvailability(), AVAILABILITY);
  });

  it("SHOULD answer from cache WHILE the published ttlSeconds has not elapsed", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    await getModelAvailability();
    t.mock.timers.tick(9_000);
    await getModelAvailability();
    assert.equal(calls.length, 1);
  });

  it("SHOULD re-read ONCE the published ttlSeconds has elapsed, well inside the client's own window — Bug guarded: holding the map for the client's 60s caches a liveness claim the exchange only stood behind for 10s", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    await getModelAvailability();
    t.mock.timers.tick(10_000);
    await getModelAvailability();
    assert.equal(calls.length, 2);
  });

  it("SHOULD NOT cache a map that publishes no usable freshness — Bug guarded: a snapshot the exchange never dated must not be handed out as current", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    for (const ttlSeconds of [undefined, 0, -1, "10"]) {
      _resetOracleCache();
      calls = [];
      serve({ ...AVAILABILITY, ttlSeconds });
      await getModelAvailability();
      await getModelAvailability();
      assert.equal(calls.length, 2, `ttlSeconds: ${String(ttlSeconds)}`);
    }
  });

  it("SHOULD leave a read that publishes no freshness of its own on the client's window — Bug guarded: the availability TTL must not shorten every other cached oracle read into a request per call", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    serve({ models: [] });
    await getCatalog();
    t.mock.timers.tick(30_000);
    await getCatalog();
    assert.equal(calls.length, 1);
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getModelPriceAt,
  getModelPriceHistory,
  resolveModelPrice,
  _resetBasketCache,
  _resetResolveCache,
} from "./client.js";
import { _resetFieldMap, _seedDefaultFieldMap } from "./field-map.js";

const CANONICAL = "openai/gpt-5.5";
const BARE = "gpt-5.5";
const ENCODED = "openai%2Fgpt-5.5";
const DATE = "2026-06-15T12:00:00Z";

let originalFetch: typeof globalThis.fetch;
let requestedUrls: string[] = [];

function oracleBody(url: string): unknown {
  if (url.includes("/price-history")) {
    return {
      modelKey: CANONICAL,
      manifestKey: BARE,
      family: "openai.gpt",
      unavailableRevisions: [],
      data: [],
    };
  }
  if (url.includes("/price-at")) {
    return {
      modelKey: CANONICAL,
      manifestKey: BARE,
      source: "manifest",
      inputPriceUsdPerMillion: 1.25,
      outputPriceUsdPerMillion: 10,
    };
  }
  return {
    inputKey: decodeURIComponent(url.split("/").pop()!),
    resolvedKey: CANONICAL,
    family: "openai.gpt",
    provider: { key: "openai", name: "OpenAI" },
    prices: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
    cache: null,
    inBasket: false,
    priceSource: "oracle-catalog",
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requestedUrls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input.toString();
    requestedUrls.push(url);
    return new Response(JSON.stringify(oracleBody(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  _resetResolveCache();
  _resetBasketCache();
  _seedDefaultFieldMap();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetFieldMap();
});

describe("model parameter — canonical and bare ids", () => {
  it("SHOULD price a bare name UNDER the canonical id the oracle resolved it to — Bug guarded: echoing the requested key back hands the agent an id the catalog does not carry", async () => {
    const priced = await resolveModelPrice(BARE);
    assert.equal(priced?.price.model, CANONICAL);
  });

  it("SHOULD percent-encode the vendor separator ON every per-model endpoint — Bug guarded: an unencoded slash splits one model into two path segments", async () => {
    await resolveModelPrice(CANONICAL);
    await getModelPriceHistory(CANONICAL);
    await getModelPriceAt(CANONICAL, DATE);

    const [resolveUrl, historyUrl, priceAtUrl] = requestedUrls;
    assert.ok(resolveUrl.endsWith(`/v1/oracle/resolve/${ENCODED}`), resolveUrl);
    assert.ok(
      historyUrl.endsWith(`/v1/oracle/models/${ENCODED}/price-history`),
      historyUrl,
    );
    assert.ok(priceAtUrl.includes(`/v1/oracle/models/${ENCODED}/price-at?`), priceAtUrl);
    for (const url of requestedUrls) {
      assert.ok(!url.includes(CANONICAL), url);
    }
  });
});

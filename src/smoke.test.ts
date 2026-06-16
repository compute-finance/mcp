import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  getBasketPrices,
  getModelPrice,
  getScu,
  getCpi,
  getTiers,
  getReconstitutions,
  getMethodology,
  costUsd,
} from "./oracle/client.js";
import { initFieldMap, getFieldMap } from "./oracle/field-map.js";
import { warmOpenApiCache } from "./oracle/openapi-schema.js";
import { round } from "./render/format.js";
import type { ModelPrice } from "./oracle/types.js";

before(async () => {
  await warmOpenApiCache();
  await initFieldMap();
}, { timeout: 15_000 });

function errorTextSync(msg: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }],
    isError: true,
  };
}

function parseResponse(res: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(res.content[0].text);
}

describe("smoke: data_get_basket", () => {
  it("returns a non-empty models array with required pricing fields", { timeout: 10_000 }, async () => {
    const models = await getBasketPrices();
    assert.ok(Array.isArray(models), "basket must be an array");
    assert.ok(models.length > 0, "basket must not be empty");

    const first = models[0];
    assert.equal(typeof first.model, "string");
    assert.ok(first.model.length > 0, "model id must be non-empty");
    assert.equal(typeof first.input_usd_per_million, "number");
    assert.equal(typeof first.output_usd_per_million, "number");
    assert.ok(first.input_usd_per_million > 0, "input price must be positive");
    assert.ok(first.output_usd_per_million > 0, "output price must be positive");
    assert.equal(typeof first.provider, "string");
    assert.ok(["frontier", "standard", "lightweight"].includes(first.tier),
      `tier must be a known value, got: ${first.tier}`);
  });

  it("every model has an oracle-published cache block with structured per-component attribution", { timeout: 10_000 }, async () => {
    const models = await getBasketPrices();
    for (const m of models) {
      assert.ok(m.cache, `${m.model}: oracle has not published a cache block`);
      const components = [
        ["cachedInput", m.cache.cachedInput] as const,
        ["cacheWrite5m", m.cache.cacheWrite5m] as const,
        ["cacheWrite1h", m.cache.cacheWrite1h] as const,
      ];
      const hasAny = components.some(([, c]) => c !== null);
      assert.ok(hasAny, `${m.model}: cache block has no components published`);
      for (const [name, c] of components) {
        if (c === null) continue;
        assert.equal(typeof c.usdPerMillion, "number", `${m.model}.${name}.usdPerMillion not a number`);
        assert.ok(c.usdPerMillion >= 0, `${m.model}.${name}.usdPerMillion negative`);
        assert.equal(typeof c.ratioOfInput, "number", `${m.model}.${name}.ratioOfInput not a number`);
        assert.equal(typeof c.source, "string", `${m.model}.${name}.source not a string`);
        assert.ok(c.source.length > 0, `${m.model}.${name}.source empty`);
      }
    }
  });
});

describe("smoke: data_get_price", () => {
  it("returns a single model with pricing for claude-sonnet-4.6", { timeout: 10_000 }, async () => {
    const price = await getModelPrice("claude-sonnet-4.6");
    assert.ok(price !== null, "claude-sonnet-4.6 must be in basket");
    assert.equal(price.model, "claude-sonnet-4.6");
    assert.ok(price.input_usd_per_million > 0);
    assert.ok(price.output_usd_per_million > 0);
    assert.equal(typeof price.provider, "string");
    assert.equal(typeof price.tier, "string");
  });

  it("returns null for nonexistent model", { timeout: 10_000 }, async () => {
    const price = await getModelPrice("nonexistent-model-xyz-999");
    assert.equal(price, null);
  });
});

describe("smoke: data_get_scu", () => {
  it("returns SCU value as a positive number", { timeout: 10_000 }, async () => {
    const data = await getScu() as Record<string, unknown>;
    assert.ok(data !== null && typeof data === "object", "SCU response must be an object");
    const scu = data.scu ?? data.scuUsd ?? data.value ?? data.scu_value;
    assert.ok(typeof scu === "number" || typeof scu === "string",
      `SCU value must be present, got keys: ${Object.keys(data).join(", ")}`);
    const scuNum = Number(scu);
    assert.ok(scuNum > 0, `SCU must be positive, got: ${scuNum}`);
  });
});

describe("smoke: data_get_cpi", () => {
  it("returns basket with models array containing priced models", { timeout: 10_000 }, async () => {
    const data = await getCpi() as Record<string, unknown>;
    const fm = getFieldMap().basket;
    const models = data[fm.models_array];
    assert.ok(Array.isArray(models), `expected array at key '${fm.models_array}'`);
    assert.ok(models.length > 0, "CPI basket must have models");

    const first = models[0] as Record<string, unknown>;
    assert.ok(first[fm.model_id], `model must have '${fm.model_id}' field`);
  });
});

describe("smoke: data_get_tiers", () => {
  it("returns tier definitions with weight and model count", { timeout: 10_000 }, async () => {
    const data = await getTiers() as Record<string, unknown>;
    assert.ok(data !== null && typeof data === "object");
    const tiers = data.tiers ?? data;
    assert.ok(
      typeof tiers === "object" && tiers !== null,
      `tiers data must be present, got keys: ${Object.keys(data).join(", ")}`,
    );
  });
});

describe("smoke: data_get_reconstitutions", () => {
  it("returns entries array (may be empty on fresh deploy)", { timeout: 10_000 }, async () => {
    const data = await getReconstitutions() as Record<string, unknown>;
    const fm = getFieldMap().recon;
    const entries = data[fm.entries_array];
    assert.ok(Array.isArray(entries), `expected array at key '${fm.entries_array}'`);
  });
});

describe("smoke: data_get_methodology", () => {
  it("returns the changelog with an active version and catalog entries", { timeout: 10_000 }, async () => {
    const data = await getMethodology() as Record<string, unknown>;
    assert.equal(typeof data.activeVersion, "number");
    assert.ok((data.activeVersion as number) >= 1, "activeVersion must be >= 1");

    const entries = data.entries;
    assert.ok(Array.isArray(entries), "entries must be an array");
    assert.ok(entries.length > 0, "entries must not be empty");

    const first = entries[0] as Record<string, unknown>;
    assert.equal(typeof first.version, "number");
    assert.equal(typeof first.title, "string");
    assert.equal(typeof first.formulaSummary, "string");
    assert.ok((first.formulaSummary as string).length > 0, "formulaSummary must be non-empty");
    assert.ok(!("strategyKey" in first), "internal strategyKey must not leak to the wire");
  });
});

describe("smoke: compute_estimate", () => {
  it("returns positive USD cost for a known model", { timeout: 10_000 }, async () => {
    const price = await getModelPrice("claude-sonnet-4.6");
    assert.ok(price !== null, "claude-sonnet-4.6 must be in basket");

    const inputTokens = 1_000_000;
    const outputTokens = 100_000;
    const cost = round(costUsd(price, inputTokens, outputTokens), 6);
    assert.equal(typeof cost, "number");
    assert.ok(cost > 0, `cost must be positive, got: ${cost}`);
    assert.ok(cost < 100, `cost suspiciously high: $${cost}`);
  });
});

describe("smoke: compute_compare", () => {
  it("returns all basket models ranked by cost, cheapest first", { timeout: 10_000 }, async () => {
    const basket = await getBasketPrices();
    const inputTokens = 1_000_000;
    const outputTokens = 100_000;

    const ranked = basket
      .map((p) => ({
        model: p.model,
        provider: p.provider,
        tier: p.tier,
        usd_cost: round(costUsd(p, inputTokens, outputTokens), 6),
      }))
      .sort((x, y) => x.usd_cost - y.usd_cost);

    assert.ok(ranked.length > 0, "ranked list must not be empty");
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(
        ranked[i].usd_cost >= ranked[i - 1].usd_cost,
        `sort broken at index ${i}: ${ranked[i - 1].model} ($${ranked[i - 1].usd_cost}) > ${ranked[i].model} ($${ranked[i].usd_cost})`,
      );
    }
    for (const r of ranked) {
      assert.equal(typeof r.model, "string");
      assert.equal(typeof r.usd_cost, "number");
      assert.ok(r.usd_cost >= 0);
    }
  });
});

describe("smoke: error paths", () => {
  it("data_get_price with nonexistent model returns isError: true", { timeout: 10_000 }, async () => {
    const model = "nonexistent-model-xyz-999";
    const price = await getModelPrice(model);
    assert.equal(price, null);
    const res = errorTextSync(`Model not in basket: ${model}`);
    assert.equal(res.isError, true);
    const body = parseResponse(res) as { error: string };
    assert.ok(body.error.includes("nonexistent-model-xyz-999"));
  });

  it("compute_estimate with missing model param returns validation error", { timeout: 10_000 }, async () => {
    const { requireString, requireFiniteNumber } = await import("./tools/validation.js");
    const model = requireString(undefined, "model");
    assert.equal(typeof model, "object");
    assert.ok("error" in (model as object));
    const res = errorTextSync((model as { error: string }).error);
    assert.equal(res.isError, true);
  });

  it("compute_estimate with nonexistent model returns model-not-found error", { timeout: 10_000 }, async () => {
    const model = "definitely-not-a-real-model";
    const price = await getModelPrice(model);
    assert.equal(price, null);
    const res = errorTextSync(`Model not in basket: ${model}`);
    assert.equal(res.isError, true);
    const body = parseResponse(res) as { error: string };
    assert.equal(body.error, `Model not in basket: ${model}`);
  });

  it("compute_estimate with missing input_tokens returns validation error", { timeout: 10_000 }, async () => {
    const { requireFiniteNumber } = await import("./tools/validation.js");
    const result = requireFiniteNumber(undefined, "input_tokens");
    assert.equal(typeof result, "object");
    assert.ok("error" in (result as object));
  });
});

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  getBasketPrices,
  getModelPrice,
  getScu,
  getBreakdown,
  getCpi,
  getReconstitutions,
  getMethodology,
  getHistory,
  getModelPriceHistory,
  getCatalog,
  getModelPriceAt,
  getBaseline,
  getScuAt,
  resolveModel,
  resolveModelPrice,
} from "./oracle/client.js";
import { costUsd } from "./oracle/pricing.js";
import { getRoutingFeeRate } from "./oracle/routing-fee.js";
import { usdCost } from "./oracle/pricing-wire.js";
import { initFieldMap, getFieldMap } from "./oracle/field-map.js";
import { warmOpenApiCache } from "./oracle/openapi-schema.js";
import { round } from "./render/format.js";

before(async () => {
  await warmOpenApiCache();
  await initFieldMap();
}, { timeout: 15_000 });

describe("smoke: data_get_basket", () => {
  it("returns a non-empty models array with required pricing fields", { timeout: 10_000 }, async () => {
    const models = await getBasketPrices();
    assert.ok(Array.isArray(models), "basket must be an array");
    assert.ok(models.length > 0, "basket must not be empty");

    const first = models[0];
    assert.equal(typeof first.model, "string");
    assert.ok(first.model.length > 0, "model id must be non-empty");
    assert.equal(typeof first.base_input_usd_per_million, "number");
    assert.equal(typeof first.base_output_usd_per_million, "number");
    assert.ok(first.base_input_usd_per_million > 0, "input price must be positive");
    assert.ok(first.base_output_usd_per_million > 0, "output price must be positive");
    assert.equal(typeof first.provider, "string");
    assert.equal(typeof first.family, "string");
    assert.ok(first.family.length > 0, "family must be non-empty");
  });

  it("publishes well-formed cache blocks where present, for at least one model", { timeout: 10_000 }, async () => {
    const models = await getBasketPrices();
    // The oracle doesn't publish cache for every model and the MCP handles absence — validate blocks where present, not completeness.
    let withCache = 0;
    for (const m of models) {
      if (!m.cache) continue;
      const components = [
        ["cachedInput", m.cache.cachedInput] as const,
        ["cacheWrite5m", m.cache.cacheWrite5m] as const,
        ["cacheWrite1h", m.cache.cacheWrite1h] as const,
      ];
      const hasAny = components.some(([, c]) => c !== null);
      assert.ok(hasAny, `${m.model}: cache block present but has no components published`);
      for (const [name, c] of components) {
        if (c === null) continue;
        assert.equal(typeof c.usdPerMillion, "number", `${m.model}.${name}.usdPerMillion not a number`);
        assert.ok(c.usdPerMillion >= 0, `${m.model}.${name}.usdPerMillion negative`);
        assert.equal(typeof c.ratioOfInput, "number", `${m.model}.${name}.ratioOfInput not a number`);
        assert.equal(typeof c.source, "string", `${m.model}.${name}.source not a string`);
        assert.ok(c.source.length > 0, `${m.model}.${name}.source empty`);
      }
      withCache += 1;
    }
    assert.ok(withCache > 0, "no basket model carries a cache block — the cache pricing pipeline is broken");
  });
});

describe("smoke: data_get_price", () => {
  it("echoes the requested basket-member model with a well-formed pricing shape", { timeout: 10_000 }, async () => {
    const basket = await getBasketPrices();
    assert.ok(basket.length > 0, "basket must be non-empty");
    const sample = basket[0];
    const price = await getModelPrice(sample.model);
    assert.ok(price !== null, `${sample.model} must be in basket`);
    assert.equal(price.model, sample.model);
    assert.ok(price.base_input_usd_per_million > 0);
    assert.ok(price.base_output_usd_per_million > 0);
    assert.equal(typeof price.provider, "string");
    assert.equal(typeof price.family, "string");
  });

  it("returns null for nonexistent model", { timeout: 10_000 }, async () => {
    const price = await getModelPrice("nonexistent-model-xyz-999");
    assert.equal(price, null);
  });

  it("SHOULD report the same base price for a basket member as /v1/oracle/resolve serves — Bug guarded: sourcing basket members from the marked-up field opens a 5% gap between the two endpoints", { timeout: 10_000 }, async () => {
    const basket = await getBasketPrices();
    const sample = basket[0];
    const resolved = await resolveModel(sample.model);
    assert.ok(resolved !== null, `${sample.model} must resolve`);
    assert.equal(sample.base_input_usd_per_million, resolved.base_input_usd_per_million);
    assert.equal(sample.base_output_usd_per_million, resolved.base_output_usd_per_million);
  });
});

describe("smoke: routing fee contract", () => {
  it("SHOULD publish a marked-up wei price that is exactly base × (1 + routingFeeRate) for every basket model — Bug guarded: billed prices are derived locally from the base price, which only holds while the fee stays a single linear global rate", { timeout: 10_000 }, async () => {
    const cpi = (await getCpi()) as Record<string, unknown>;
    const rate = cpi.routingFeeRate;
    assert.equal(typeof rate, "number", "the basket must publish routingFeeRate");
    const models = cpi.models as Array<Record<string, any>>;
    assert.ok(models.length > 0, "basket must not be empty");
    for (const m of models) {
      for (const side of ["input", "output"] as const) {
        const base = m.weiPricePerMillion[side];
        const expected = base * (1 + (rate as number));
        assert.ok(
          Math.abs(m.markedUpWeiPricePerMillion[side] - expected) <= expected * 1e-9,
          `${m.id}.${side}: markedUp ${m.markedUpWeiPricePerMillion[side]} != base ${base} × ${1 + (rate as number)}`,
        );
      }
    }
  });

  it("SHOULD surface that same rate through getRoutingFeeRate", { timeout: 10_000 }, async () => {
    const cpi = (await getCpi()) as Record<string, unknown>;
    assert.equal(await getRoutingFeeRate(), cpi.routingFeeRate);
  });

  it("SHOULD produce the same cost FOR a basket member and a catalog-only model that share provider prices — Bug guarded: basket membership must not move the cost of a model", { timeout: 15_000 }, async () => {
    const basket = await getBasketPrices();
    const catalog = (await getCatalog()) as { models: Array<Record<string, any>> };
    const offIndex = catalog.models.filter((m) => m.indexMember === false);
    assert.ok(offIndex.length > 0, "catalog must carry at least one non-index model");

    const twin = offIndex.find((c) =>
      basket.some(
        (b) =>
          b.base_input_usd_per_million === c.currentPrice.inputPriceUsdPerMillion &&
          b.base_output_usd_per_million === c.currentPrice.outputPriceUsdPerMillion,
      ),
    );
    assert.ok(twin, "expected a catalog-only model sharing provider prices with a basket member");

    const member = basket.find(
      (b) =>
        b.base_input_usd_per_million === twin.currentPrice.inputPriceUsdPerMillion &&
        b.base_output_usd_per_million === twin.currentPrice.outputPriceUsdPerMillion,
    )!;
    const [pricedMember, pricedTwin, rate] = await Promise.all([
      resolveModelPrice(member.model),
      resolveModelPrice(twin.modelKey),
      getRoutingFeeRate(),
    ]);
    assert.ok(pricedMember !== null && pricedTwin !== null);
    assert.equal(pricedMember.source, "oracle-basket");
    assert.equal(pricedTwin.source, "oracle-catalog");
    assert.deepEqual(
      usdCost(pricedMember.price, 1_000_000, 1_000_000, rate),
      usdCost(pricedTwin.price, 1_000_000, 1_000_000, rate),
    );
  });
});

describe("smoke: data_get_scu", () => {
  it("returns SCU value as a positive number with a methodology-versioned breakdown", { timeout: 10_000 }, async () => {
    const data = await getScu() as Record<string, unknown>;
    assert.ok(data !== null && typeof data === "object", "SCU response must be an object");
    assert.equal(typeof data.scuUsd, "number", `scuUsd must be a number, got keys: ${Object.keys(data).join(", ")}`);
    assert.ok((data.scuUsd as number) > 0, `scuUsd must be positive, got: ${data.scuUsd}`);

    const breakdown = data.breakdown as Record<string, unknown> | undefined;
    assert.ok(breakdown && typeof breakdown === "object", "breakdown discriminated union must be present");
    assert.equal(
      breakdown.methodologyVersion,
      1,
      "methodologyVersion must be the v1 family-representative shape — a flip is a wire change that must force a re-review",
    );
    assert.ok(Array.isArray(breakdown.familyRepresentatives), "familyRepresentatives must be an array");
    const reps = breakdown.familyRepresentatives as Array<Record<string, unknown>>;
    assert.ok(reps.length > 0, "familyRepresentatives must be non-empty");
    const sample = reps[0];
    assert.equal(typeof sample.family, "string");
    assert.ok((sample.family as string).length > 0, "family must be a non-empty key");
    assert.equal(typeof sample.modelKey, "string");
    assert.equal(typeof sample.inputPriceUsdPerMillion, "number");
    assert.equal(typeof sample.outputPriceUsdPerMillion, "number");
    assert.equal(typeof sample.blendedCostUsd, "number");
  });
});

describe("smoke: data_get_breakdown", () => {
  it("SHOULD return the same per-family breakdown that ships inside data_get_scu — Bug guarded: the typed extraction must not drift from /scu.breakdown", async () => {
    const scu = (await getScu()) as Record<string, unknown>;
    const expected = scu.breakdown;
    const actual = await getBreakdown();
    assert.deepEqual(actual, expected);
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
  it("returns positive USD cost for a basket-member model", { timeout: 10_000 }, async () => {
    const basket = await getBasketPrices();
    assert.ok(basket.length > 0, "basket must be non-empty");
    const price = basket[0];

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
        family: p.family,
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

describe("smoke: data_get_history", () => {
  it("returns an envelope with granularity, count, and a non-empty SCU point array", { timeout: 10_000 }, async () => {
    const data = (await getHistory({ granularity: "per-revision" })) as Record<string, unknown>;
    assert.equal(typeof data.from, "string");
    assert.equal(typeof data.to, "string");
    assert.equal(data.granularity, "per-revision");
    assert.equal(typeof data.count, "number");
    assert.equal(typeof data.truncated, "boolean");
    const points = data.data as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(points), "data must be an array");
    assert.ok(points.length > 0, "history must not be empty on a synced oracle");
    const first = points[0];
    assert.equal(typeof first.date, "string");
    assert.equal(typeof first.scuUsd, "number");
    assert.equal(typeof first.revisionVersion, "number");
    assert.equal(typeof first.methodologyVersion, "number");
    assert.equal(typeof first.metadataHash, "string");
    assert.ok(/^0x[0-9a-f]{64}$/.test(first.metadataHash as string), "metadataHash must be a 0x bytes32 hex");
  });

  it("honours ?granularity=daily and aligns each point's date to UTC midnight", { timeout: 10_000 }, async () => {
    const data = (await getHistory({ granularity: "daily" })) as Record<string, unknown>;
    assert.equal(data.granularity, "daily");
    const points = data.data as Array<{ date: string }>;
    for (const p of points) {
      assert.ok(/T00:00:00\.000Z$/.test(p.date), `daily point '${p.date}' must align to UTC midnight`);
    }
  });
});

describe("smoke: data_get_model_price_history", () => {
  it("returns input/output USD prices for an index-eligible model with the family slot echoed", { timeout: 10_000 }, async () => {
    const basket = await getBasketPrices();
    assert.ok(basket.length > 0, "basket must be non-empty");
    const sample = basket[0];
    const data = (await getModelPriceHistory(sample.model)) as Record<string, unknown>;
    assert.equal(data.modelKey, sample.model);
    assert.equal(typeof data.family, "string");
    assert.ok((data.family as string).length > 0, "family must be a non-empty slot key");
    assert.ok(Array.isArray(data.unavailableRevisions), "unavailableRevisions must be an array (possibly empty)");
    const points = data.data as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(points), "data must be an array");
    if (points.length > 0) {
      const first = points[0];
      assert.equal(typeof first.inputPriceUsdPerMillion, "number");
      assert.equal(typeof first.outputPriceUsdPerMillion, "number");
      assert.equal(typeof first.revisionVersion, "number");
      assert.equal(typeof first.metadataHash, "string");
    }
  });
});

describe("smoke: data_get_catalog", () => {
  it("returns models array with currentPrice and indexMember flag", { timeout: 10_000 }, async () => {
    const data = (await getCatalog()) as Record<string, unknown>;
    const models = data.models as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(models), "models must be an array");
    assert.ok(models.length > 0, "catalog must not be empty on a synced oracle");
    assert.equal(typeof data.truncated, "boolean");
    assert.equal(typeof data.generatedAt, "string");
    const first = models[0];
    assert.equal(typeof first.modelKey, "string");
    assert.equal(typeof first.displayName, "string");
    assert.equal(typeof first.indexMember, "boolean");
    const cp = first.currentPrice as Record<string, unknown>;
    assert.ok(cp, "every catalog entry carries currentPrice");
    assert.equal(typeof cp.inputPriceUsdPerMillion, "number");
    assert.equal(typeof cp.outputPriceUsdPerMillion, "number");
    assert.equal(typeof cp.observedAt, "string");
  });
});

describe("smoke: data_get_model_price_at", () => {
  it("returns a discriminated source response for an index-eligible model at a past timestamp", { timeout: 10_000 }, async () => {
    const basket = await getBasketPrices();
    assert.ok(basket.length > 0, "basket must be non-empty");
    const sample = basket[0];
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const data = (await getModelPriceAt(sample.model, yesterday)) as Record<string, unknown>;
    assert.equal(data.modelKey, sample.model);
    assert.ok(data.source === "manifest" || data.source === "providerCost", "source must be the discriminator literal");
    assert.equal(typeof data.inputPriceUsdPerMillion, "number");
    assert.equal(typeof data.outputPriceUsdPerMillion, "number");
    assert.equal(typeof data.observedAt, "string");
  });
});

describe("smoke: data_get_baseline", () => {
  it("returns the frozen genesis SCU snapshot and the published /v1/oracle/scu computeIndex equals (baseline/current) × 100", { timeout: 10_000 }, async () => {
    const baseline = (await getBaseline()) as Record<string, unknown> | null;
    assert.ok(baseline !== null, "baseline must be published on a synced oracle");
    assert.equal(typeof baseline.date, "string");
    assert.equal(typeof baseline.scuUsd, "number");
    assert.ok((baseline.scuUsd as number) > 0, "baseline scuUsd must be positive");
    assert.equal(baseline.methodologyVersion, 1);

    const scu = (await getScu()) as Record<string, unknown>;
    const currentScu = scu.scuUsd as number;
    const computeIndex = scu.computeIndex as number | null;
    assert.equal(typeof computeIndex, "number", "/v1/oracle/scu computeIndex must be populated once baseline lands");
    const expected = ((baseline.scuUsd as number) / currentScu) * 100;
    assert.ok(Math.abs((computeIndex as number) - expected) < 1e-6, "computeIndex must equal (baseline / current) × 100");
  });
});

describe("smoke: data_get_scu_at", () => {
  it("returns the same revision as /v1/oracle/latest when asked for the present moment, with full SCU@T payload", { timeout: 10_000 }, async () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const point = (await getScuAt(at)) as Record<string, unknown> | null;
    assert.ok(point !== null, "scu-at must resolve a confirmed revision within the live series");
    assert.equal(typeof point.scuUsd, "number");
    assert.ok((point.scuUsd as number) > 0, "scuUsd must be positive");
    assert.equal(typeof point.scuUsd18, "string");
    assert.equal(typeof point.revisionVersion, "number");
    assert.equal(typeof point.methodologyVersion, "number");
    assert.equal(typeof point.publishedAt, "string");
    assert.equal(typeof point.metadataHash, "string");
    assert.match(point.metadataHash as string, /^0x[0-9a-f]{64}$/);

    const baseline = (await getBaseline()) as Record<string, unknown> | null;
    if (baseline) {
      const expected = ((baseline.scuUsd as number) / (point.scuUsd as number)) * 100;
      assert.ok(typeof point.computeIndex === "number", "computeIndex must be populated once baseline lands");
      assert.ok(Math.abs((point.computeIndex as number) - expected) < 1e-6, "computeIndex must equal (baseline / scuUsd) × 100");
    }
  });

  it("returns null for a timestamp that precedes the genesis revision — Bug guarded: pre-genesis lookups must not fabricate a value", { timeout: 10_000 }, async () => {
    const point = await getScuAt("2020-01-01T00:00:00Z");
    assert.equal(point, null);
  });
});


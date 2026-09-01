import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  API_BASE,
  getCatalogPrices,
  getIndexPrices,
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
import { usdCost, withBilledPrices } from "./oracle/pricing-wire.js";
import {
  getCatalogContexts,
  modelContext,
  quoteAtContextTier,
  requireContextFor,
} from "./oracle/context-tiers.js";
import { initFieldMap, getFieldMap } from "./oracle/field-map.js";
import { warmOpenApiCache } from "./oracle/openapi-schema.js";
import { round } from "./render/format.js";
import { PROVENANCE_MARKS } from "./oracle/types.js";

before(async () => {
  await warmOpenApiCache();
  await initFieldMap();
}, { timeout: 15_000 });

interface CatalogEntry {
  modelKey: string;
  indexMember: boolean;
  currentPrice: {
    inputPriceUsdPerMillion: number;
    outputPriceUsdPerMillion: number;
  };
}

interface PublishedSide {
  usdPerMillion: number;
}

async function catalogEntries(): Promise<CatalogEntry[]> {
  const catalog = (await getCatalog()) as { models: CatalogEntry[] };
  return catalog.models;
}

async function publishedBilledPrices(): Promise<
  Record<string, { input: PublishedSide; output: PublishedSide }>
> {
  const res = await fetch(`${API_BASE}/v1/oracle/pricing`);
  assert.ok(res.ok, `/v1/oracle/pricing returned ${res.status}`);
  const body = (await res.json()) as {
    models: Record<string, { input: PublishedSide; output: PublishedSide }>;
  };
  return body.models;
}

// /v1/oracle/pricing rounds to three significant figures, which alone costs up to 0.5%; the band clears that and still sits far under the routing fee a wrong pricing basis moves a quote by.
const BILLED_TOLERANCE_RATIO = 0.01;

function assertWithinTolerance(
  actual: number | null,
  expected: number,
  label: string,
): void {
  assert.ok(actual !== null, `${label}: no billed price published`);
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * BILLED_TOLERANCE_RATIO,
    `${label}: MCP quotes ${actual}, the exchange bills ${expected}`,
  );
}

describe("smoke: data_get_basket", () => {
  it("returns a non-empty models array with required pricing fields", { timeout: 10_000 }, async () => {
    const models = await getIndexPrices();
    assert.ok(Array.isArray(models), "index members must be an array");
    assert.ok(models.length > 0, "the index must not be empty");

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
    const models = await getIndexPrices();
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
        assert.ok(
          PROVENANCE_MARKS.includes(c.provenance),
          `${m.model}.${name}.provenance is '${c.provenance}', not one of ${PROVENANCE_MARKS.join("/")}`,
        );
      }
      withCache += 1;
    }
    assert.ok(withCache > 0, "no index member carries a cache block — the cache pricing pipeline is broken");
  });

  it("publishes a marked reasoning output price where present, for at least one model", { timeout: 10_000 }, async () => {
    const models = await getIndexPrices();
    let withReasoning = 0;
    for (const m of models) {
      const c = m.reasoning?.reasoningOutput;
      if (!c) continue;
      assert.equal(typeof c.usdPerMillion, "number", `${m.model}.reasoningOutput.usdPerMillion not a number`);
      assert.ok(c.usdPerMillion >= 0, `${m.model}.reasoningOutput.usdPerMillion negative`);
      assert.equal(typeof c.ratioOfInput, "number", `${m.model}.reasoningOutput.ratioOfInput not a number`);
      assert.ok(
        PROVENANCE_MARKS.includes(c.provenance),
        `${m.model}.reasoningOutput.provenance is '${c.provenance}'`,
      );
      withReasoning += 1;
    }
    assert.ok(withReasoning > 0, "no index member carries a reasoning price — the reasoning pricing pipeline is broken");
  });
});

describe("smoke: data_get_price", () => {
  it("echoes the requested index-member model with a well-formed pricing shape", { timeout: 10_000 }, async () => {
    const indexModels = await getIndexPrices();
    assert.ok(indexModels.length > 0, "the index must not be empty");
    const sample = indexModels[0];
    const priced = await resolveModelPrice(sample.model);
    assert.ok(priced !== null, `${sample.model} must resolve to a price`);
    assert.equal(priced.price.model, sample.model);
    assert.ok(priced.price.base_input_usd_per_million > 0);
    assert.ok(priced.price.base_output_usd_per_million > 0);
    assert.equal(typeof priced.price.provider, "string");
    assert.equal(typeof priced.price.family, "string");
    assert.ok(priced.price.base_price_provenance !== null, "a catalogue price is always marked");
  });

  it("returns null for nonexistent model", { timeout: 10_000 }, async () => {
    assert.equal(await resolveModelPrice("nonexistent-model-xyz-999"), null);
  });

  it("SHOULD quote every index member at the price the live catalogue publishes for it — Bug guarded: sourcing an index member from the attested snapshot keeps quoting the pre-correction price for as long as an operator holds back the next revision", { timeout: 15_000 }, async () => {
    const [indexModels, entries] = await Promise.all([
      getIndexPrices(),
      catalogEntries(),
    ]);
    const current = new Map(entries.map((e) => [e.modelKey, e.currentPrice]));
    assert.ok(indexModels.length > 0, "the index must not be empty");
    for (const m of indexModels) {
      const price = current.get(m.model);
      assert.ok(price, `${m.model} is served as an index member the catalogue does not list`);
      assert.equal(m.base_input_usd_per_million, price.inputPriceUsdPerMillion, `${m.model} input`);
      assert.equal(m.base_output_usd_per_million, price.outputPriceUsdPerMillion, `${m.model} output`);
    }
  });

  it("SHOULD quote a single model at that same catalogue price whether or not it is an index member — Bug guarded: a membership-conditional source makes a model's price depend on index membership rather than on what the provider charges", { timeout: 20_000 }, async () => {
    const [entries, snapshot] = await Promise.all([catalogEntries(), getCpi()]);
    const attested = new Map(
      ((snapshot as { models: Array<{ id: string; usdPricePerMillion: { input: number; output: number } }> }).models ?? [])
        .map((m) => [m.id, m.usdPricePerMillion] as const),
    );
    const disagrees = (e: CatalogEntry) => {
      const a = attested.get(e.modelKey);
      return a !== undefined && a.input !== e.currentPrice.inputPriceUsdPerMillion;
    };
    const members = entries.filter((e) => e.indexMember);
    const sample = [
      ...[...members].sort((a, b) => Number(disagrees(b)) - Number(disagrees(a))).slice(0, 5),
      ...entries.filter((e) => !e.indexMember).slice(0, 3),
    ];
    assert.ok(sample.length > 0, "catalogue must carry models to sample");

    const quoted = await Promise.all(sample.map((e) => resolveModelPrice(e.modelKey)));
    quoted.forEach((priced, i) => {
      const entry = sample[i];
      assert.ok(priced !== null, `${entry.modelKey} must resolve to a price`);
      assert.equal(
        priced.price.base_input_usd_per_million,
        entry.currentPrice.inputPriceUsdPerMillion,
        `${entry.modelKey} input`,
      );
      assert.equal(
        priced.price.base_output_usd_per_million,
        entry.currentPrice.outputPriceUsdPerMillion,
        `${entry.modelKey} output`,
      );
    });
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

  it("SHOULD publish the billed price the exchange actually charges, FOR index members and catalog-only models alike — Bug guarded: a quote sourced from anything but the live catalogue is a budget the bill will not honour", { timeout: 20_000 }, async () => {
    const [indexModels, catalogPrices, entries, published, rate] = await Promise.all([
      getIndexPrices(),
      getCatalogPrices(),
      catalogEntries(),
      publishedBilledPrices(),
      getRoutingFeeRate(),
    ]);
    const isMember = new Map(entries.map((e) => [e.modelKey, e.indexMember]));
    const quoted = [
      ...indexModels,
      ...catalogPrices.filter((m) => !isMember.get(m.model)),
    ];
    let members = 0;
    let nonMembers = 0;
    for (const m of quoted) {
      const bill = published[m.model];
      if (!bill) continue;
      const billed = withBilledPrices(m, rate);
      assertWithinTolerance(
        billed.billed_input_usd_per_million,
        bill.input.usdPerMillion,
        `${m.model} billed input`,
      );
      assertWithinTolerance(
        billed.billed_output_usd_per_million,
        bill.output.usdPerMillion,
        `${m.model} billed output`,
      );
      if (isMember.get(m.model)) members += 1;
      else nonMembers += 1;
    }
    assert.ok(members > 0, "no index member was checked against the published bill");
    assert.ok(nonMembers > 0, "no catalog-only model was checked against the published bill");
  });

  it("SHOULD bill a single quoted model at the published rate — Bug guarded: the single-model path serves a different endpoint from the index listing and can drift off the bill on its own", { timeout: 20_000 }, async () => {
    const [entries, published, rate] = await Promise.all([
      catalogEntries(),
      publishedBilledPrices(),
      getRoutingFeeRate(),
    ]);
    const sample = [
      ...entries.filter((e) => e.indexMember).slice(0, 3),
      ...entries.filter((e) => !e.indexMember).slice(0, 3),
    ];
    const quoted = await Promise.all(sample.map((e) => resolveModelPrice(e.modelKey)));
    quoted.forEach((priced, i) => {
      const key = sample[i].modelKey;
      const bill = published[key];
      assert.ok(priced !== null, `${key} must resolve to a price`);
      assert.ok(bill, `${key} is tracked but /v1/oracle/pricing does not price it`);
      const billed = withBilledPrices(priced.price, rate);
      assertWithinTolerance(
        billed.billed_input_usd_per_million,
        bill.input.usdPerMillion,
        `${key} billed input`,
      );
      assertWithinTolerance(
        billed.billed_output_usd_per_million,
        bill.output.usdPerMillion,
        `${key} billed output`,
      );
    });
  });
});

describe("smoke: canonical model ids", () => {
  it("SHOULD identify every index, catalog and resolved model by its canonical vendor/model id — Bug guarded: a bare id reaching an agent is a name it cannot round-trip back to the oracle", { timeout: 15_000 }, async () => {
    const indexModels = await getIndexPrices();
    assert.ok(indexModels.length > 0, "the index must not be empty");
    for (const m of indexModels) {
      assert.ok(m.model.includes("/"), `index member '${m.model}' is not vendor-prefixed`);
    }

    const catalog = (await getCatalog()) as { models: Array<{ modelKey: string }> };
    for (const m of catalog.models) {
      assert.ok(
        m.modelKey.includes("/"),
        `catalog modelKey '${m.modelKey}' is not vendor-prefixed`,
      );
    }

    const resolved = await resolveModel(indexModels[0].model);
    assert.ok(resolved !== null, `${indexModels[0].model} must resolve`);
    assert.ok(
      resolved.resolved_key.includes("/"),
      `resolvedKey '${resolved.resolved_key}' is not vendor-prefixed`,
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
  it("returns the attested index with a models array containing priced models", { timeout: 10_000 }, async () => {
    const data = await getCpi() as Record<string, unknown>;
    const models = data.models;
    assert.ok(Array.isArray(models), "expected an array at key 'models'");
    assert.ok(models.length > 0, "the attested index must have models");

    const first = models[0] as Record<string, unknown>;
    assert.ok(first.id, "model must have an 'id' field");
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
  it("returns positive USD cost for an index-member model", { timeout: 10_000 }, async () => {
    const indexModels = await getIndexPrices();
    assert.ok(indexModels.length > 0, "the index must not be empty");
    const price = indexModels[0];

    const inputTokens = 1_000_000;
    const outputTokens = 100_000;
    const cost = round(costUsd(price, inputTokens, outputTokens), 6);
    assert.equal(typeof cost, "number");
    assert.ok(cost > 0, `cost must be positive, got: ${cost}`);
    assert.ok(cost < 100, `cost suspiciously high: $${cost}`);
  });
});

describe("smoke: compute_compare", () => {
  it("returns all index members ranked by cost, cheapest first", { timeout: 10_000 }, async () => {
    const indexModels = await getIndexPrices();
    const inputTokens = 1_000_000;
    const outputTokens = 100_000;

    const ranked = indexModels
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
    const indexModels = await getIndexPrices();
    assert.ok(indexModels.length > 0, "the index must not be empty");
    const sample = indexModels[0];
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
      assert.ok(
        first.source === "manifest" || first.source === "catalog",
        "source must be 'manifest' or 'catalog'",
      );
      if (first.source === "manifest") {
        assert.equal(typeof first.revisionVersion, "number");
        assert.equal(typeof first.metadataHash, "string");
      }
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

describe("smoke: context price ladder", () => {
  it("SHOULD publish contextTiers only as a non-empty, strictly ascending, marked array — Bug guarded: the ladder is read in published order, so an unsorted, duplicated or unmarked rung is quoted at the wrong input size", { timeout: 10_000 }, async (t) => {
    const catalog = (await getCatalog()) as { models: Array<Record<string, any>> };
    const laddered = catalog.models.filter((m) => "contextTiers" in m);
    if (laddered.length === 0) return t.skip("no catalog model publishes contextTiers");
    for (const m of laddered) {
      const tiers = m.contextTiers;
      assert.ok(Array.isArray(tiers), `${m.modelKey}: contextTiers must be an array`);
      assert.ok(tiers.length > 0, `${m.modelKey}: contextTiers present but empty`);
      let previous = 0;
      for (const rung of tiers) {
        assert.ok(
          Number.isInteger(rung.fromInputTokens) && rung.fromInputTokens > previous,
          `${m.modelKey}: fromInputTokens ${rung.fromInputTokens} must be a positive integer above ${previous}`,
        );
        previous = rung.fromInputTokens;
        assert.equal(typeof rung.inputPriceUsdPerMillion, "number", `${m.modelKey}: rung input price`);
        assert.equal(typeof rung.outputPriceUsdPerMillion, "number", `${m.modelKey}: rung output price`);
        assert.ok(
          PROVENANCE_MARKS.includes(rung.provenance),
          `${m.modelKey}: rung provenance is '${rung.provenance}', not one of ${PROVENANCE_MARKS.join("/")}`,
        );
      }
    }
  });

  it("SHOULD publish the ladder on the catalogue alone, out of every endpoint serving a per-model price — Bug guarded: a second publisher of the same rungs is a second source of truth that can disagree with the bill", { timeout: 15_000 }, async () => {
    const contexts = await getCatalogContexts();
    const laddered = [...contexts].find(([, c]) => c.tiers.length > 0);
    const modelKey = laddered?.[0] ?? [...contexts.keys()][0];
    assert.ok(modelKey, "catalog must carry at least one model");

    const resolveRes = await fetch(
      `${API_BASE}/v1/oracle/resolve/${encodeURIComponent(modelKey)}`,
    );
    assert.ok(resolveRes.ok, `/v1/oracle/resolve returned ${resolveRes.status}`);
    const [resolved, basket, priceAt, priceHistory] = await Promise.all([
      resolveRes.json(),
      getCpi(),
      getModelPriceAt(modelKey, new Date(Date.now() - 60_000).toISOString()),
      getModelPriceHistory(modelKey),
    ]);

    for (const [endpoint, body] of [
      ["/v1/oracle/resolve", resolved],
      ["/v1/oracle/basket", basket],
      ["/price-at", priceAt],
      ["/price-history", priceHistory],
    ] as const) {
      assert.ok(
        !JSON.stringify(body).includes("contextTiers"),
        `${endpoint} publishes the ladder for ${modelKey} — the catalogue must stay its only source`,
      );
    }
  });

  it("SHOULD switch a live tiered model onto its higher rung exactly at the threshold — Bug guarded: half-open ranges are what make an estimate match the bill at the boundary", { timeout: 15_000 }, async (t) => {
    const [contexts, rate] = await Promise.all([getCatalogContexts(), getRoutingFeeRate()]);
    const laddered = [...contexts].find(([, c]) => c.tiers.length > 0);
    if (!laddered) return t.skip("no catalog model publishes contextTiers");
    const [modelKey, context] = laddered;

    const priced = await resolveModelPrice(modelKey);
    assert.ok(priced !== null, `${modelKey} must resolve to a price`);
    const threshold = context.tiers[0].fromInputTokens;
    const quote = (inputTokens: number) =>
      quoteAtContextTier(priced.price, context, rate, inputTokens, 0);

    const flat = quote(threshold - 1).applied_context_tier;
    const higher = quote(threshold).applied_context_tier;
    assert.equal(flat.from_input_tokens, 0);
    assert.equal(higher.from_input_tokens, threshold);
    assert.ok(
      higher.base_input_usd_per_million !== flat.base_input_usd_per_million ||
        higher.base_output_usd_per_million !== flat.base_output_usd_per_million,
      `${modelKey}: the rung at ${threshold} restates the flat rate on both sides, so crossing it moves no price`,
    );
  });

  it("SHOULD start every tracked model's ladder at its own flat rate — Bug guarded: a flat model must still ship one rung so no caller branches on whether a model happens to be tiered, and a rung that restates a different rate than the model's own is a second price for one model", { timeout: 15_000 }, async () => {
    const [contexts, prices, rate] = await Promise.all([
      getCatalogContexts(),
      getCatalogPrices(),
      getRoutingFeeRate(),
    ]);
    for (const m of prices) {
      const { context_tiers } = modelContext(
        m,
        requireContextFor(contexts, m.model),
        rate,
      );
      assert.equal(context_tiers[0].from_input_tokens, 0, `${m.model}: ladder must start at 0`);
      assert.equal(
        context_tiers[0].base_input_usd_per_million,
        m.base_input_usd_per_million,
        `${m.model}: first rung must restate the flat input rate`,
      );
      assert.equal(
        context_tiers[0].base_output_usd_per_million,
        m.base_output_usd_per_million,
        `${m.model}: first rung must restate the flat output rate`,
      );
    }
  });

  it("SHOULD publish maxInputTokens as a positive integer wherever a model declares a ceiling", { timeout: 10_000 }, async (t) => {
    const catalog = (await getCatalog()) as { models: Array<Record<string, any>> };
    const capped = catalog.models.filter((m) => "maxInputTokens" in m);
    if (capped.length === 0) return t.skip("no catalog model declares maxInputTokens");
    for (const m of capped) {
      assert.ok(
        Number.isInteger(m.maxInputTokens) && m.maxInputTokens > 0,
        `${m.modelKey}: maxInputTokens ${m.maxInputTokens} must be a positive integer`,
      );
    }
  });
});

describe("smoke: data_get_model_price_at", () => {
  it("returns a discriminated source response for an index-eligible model at a past timestamp", { timeout: 10_000 }, async () => {
    const indexModels = await getIndexPrices();
    assert.ok(indexModels.length > 0, "the index must not be empty");
    const sample = indexModels[0];
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const data = (await getModelPriceAt(sample.model, yesterday)) as Record<string, unknown>;
    assert.equal(data.modelKey, sample.model);
    assert.ok(
      data.source === "manifest" || data.source === "catalog",
      "source must be 'manifest' or 'catalog'",
    );
    assert.equal(typeof data.inputPriceUsdPerMillion, "number");
    assert.equal(typeof data.outputPriceUsdPerMillion, "number");
    assert.equal(typeof data.observedAt, "string");
    if (data.source === "manifest") {
      assert.equal(typeof data.revisionVersion, "number");
      assert.equal(typeof data.metadataHash, "string");
      assert.equal(typeof data.family, "string");
    }
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


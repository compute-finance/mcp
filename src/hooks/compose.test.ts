import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeHookLine, HookComposeInputs } from "./compose.js";

const basket = (
  overrides: Partial<Extract<HookComposeInputs, { mode: "basket" }>> = {},
): HookComposeInputs => ({
  mode: "basket",
  effective_usd: 52,
  nominal_usd: 325,
  scu_usd: 0.0024,
  subscription: false,
  ...overrides,
});

const offBasket = (
  overrides: Partial<Extract<HookComposeInputs, { mode: "off_basket" }>> = {},
): HookComposeInputs => ({
  mode: "off_basket",
  fresh_tokens: 500_000,
  cached_tokens: 21_000_000,
  cost_usd: 52,
  subscription: false,
  ...overrides,
});

describe("composeHookLine — basket mode", () => {
  it("SHOULD render SCU-led line with cache segment WHEN savings above noise threshold", () => {
    const out = composeHookLine(basket());
    assert.match(out, /^💰 Compute\.Finance · \d/);
    assert.ok(out.includes("SCU ($52.00)"));
    assert.ok(out.includes("cache saved 84%"));
  });

  it("SHOULD drop cache segment WHEN nominal equals effective", () => {
    const out = composeHookLine(basket({ nominal_usd: 52 }));
    assert.ok(!out.includes("cache"));
  });

  it("SHOULD drop cache segment WHEN savings round below 1%", () => {
    const out = composeHookLine(basket({ nominal_usd: 52.2 }));
    assert.ok(!out.includes("cache"));
  });

  it("SHOULD drop cache segment WHEN nominal is zero", () => {
    const out = composeHookLine(basket({ nominal_usd: 0, effective_usd: 0 }));
    assert.ok(!out.includes("cache"));
  });

  it("SHOULD drop cache segment WHEN effective exceeds nominal", () => {
    const out = composeHookLine(basket({ effective_usd: 100, nominal_usd: 50 }));
    assert.ok(!out.includes("cache"));
  });

  it("SHOULD cap cache segment at 99% WHEN savings round to 100%", () => {
    const out = composeHookLine(basket({ effective_usd: 0.01, nominal_usd: 1000 }));
    assert.ok(out.includes("cache saved 99%"));
  });

  it("SHOULD wrap USD with API-equiv suffix WHEN subscription", () => {
    const out = composeHookLine(basket({ subscription: true }));
    assert.ok(out.includes("(~$52.00 API-equiv)"));
    assert.ok(!out.match(/\(\$\d/));
  });
});

describe("composeHookLine — off-basket mode", () => {
  it("SHOULD render USD plus token split WHEN cost is known", () => {
    const out = composeHookLine(offBasket());
    assert.ok(out.includes("$52.00"));
    assert.ok(out.includes("500.0k fresh / 21.0M cached"));
  });

  it("SHOULD drop USD segment WHEN cost is null", () => {
    const out = composeHookLine(offBasket({ cost_usd: null }));
    assert.ok(!out.match(/\$\d/));
    assert.ok(out.includes("500.0k fresh / 21.0M cached"));
  });

  it("SHOULD drop cached portion WHEN cached tokens is zero", () => {
    const out = composeHookLine(offBasket({ cached_tokens: 0 }));
    assert.ok(out.endsWith("fresh"));
    assert.ok(!out.includes("cached"));
  });

  it("SHOULD wrap USD with API-equiv suffix WHEN subscription", () => {
    const out = composeHookLine(offBasket({ subscription: true }));
    assert.ok(out.includes("~$52.00 API-equiv"));
  });
});

describe("composeHookLine — invariants", () => {
  const adversarialCases: HookComposeInputs[] = [
    basket({ effective_usd: 0.0001, nominal_usd: 1000 }),
    basket({ effective_usd: 9999.99, nominal_usd: 10000 }),
    basket({ subscription: true, effective_usd: 0.5, nominal_usd: 0.5 }),
    offBasket({ fresh_tokens: 0, cached_tokens: 0, cost_usd: null }),
    offBasket({ fresh_tokens: 1, cached_tokens: 999_999_999 }),
    offBasket({ cost_usd: 0.0001, subscription: true }),
  ];

  for (const [idx, input] of adversarialCases.entries()) {
    it(`SHOULD never emit NaN/Infinity/null/undefined for adversarial input #${idx}`, () => {
      const out = composeHookLine(input);
      assert.ok(out.startsWith("💰 Compute.Finance · "));
      for (const bad of ["NaN", "Infinity", "null", "undefined"]) {
        assert.ok(!out.includes(bad), `output contained "${bad}": ${out}`);
      }
    });
  }
});

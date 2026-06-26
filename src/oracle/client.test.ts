import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHistoryQueryString } from "./client.js";

describe("buildHistoryQueryString", () => {
  it("returns an empty string when no query params are set", () => {
    assert.equal(buildHistoryQueryString({}), "");
  });

  it("emits only the keys that are present — undefined keys are not serialised", () => {
    assert.equal(buildHistoryQueryString({ granularity: "daily" }), "?granularity=daily");
  });

  it("preserves the order from from → to → granularity → limit", () => {
    assert.equal(
      buildHistoryQueryString({
        from: "2026-04-01T00:00:00Z",
        to: "2026-06-01T00:00:00Z",
        granularity: "weekly",
        limit: 50,
      }),
      "?from=2026-04-01T00%3A00%3A00Z&to=2026-06-01T00%3A00%3A00Z&granularity=weekly&limit=50",
    );
  });

  it("serialises limit=0 (numeric) — must not be silently dropped as a falsy value", () => {
    assert.equal(buildHistoryQueryString({ limit: 0 }), "?limit=0");
  });
});

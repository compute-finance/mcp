import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { getActiveMethodologyVersion } from "./client.js";

describe("getActiveMethodologyVersion — negative paths", () => {
  it("returns null when the oracle is unreachable (cold cache — must run before any successful fetch caches a payload)", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("network down");
    });
    try {
      assert.equal(await getActiveMethodologyVersion(), null);
    } finally {
      mock.restoreAll();
    }
  });

  it("returns null when the changelog payload has no numeric activeVersion", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ activeVersion: "not-a-number", entries: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      assert.equal(await getActiveMethodologyVersion(), null);
    } finally {
      mock.restoreAll();
    }
  });
});

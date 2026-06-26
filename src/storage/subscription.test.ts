import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSubscription } from "./subscription.js";

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cf-subscription-"));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeClaude(name: string, content: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, content);
  return path;
}

describe("detectSubscription", () => {
  it("SHOULD report false WHEN file does not exist", () => {
    const result = detectSubscription(join(tmpDir, "nonexistent.json"));
    assert.deepEqual(result, { isSubscription: false });
  });

  it("SHOULD report false WHEN JSON is malformed", () => {
    const path = writeClaude("broken.json", "{not valid json");
    assert.deepEqual(detectSubscription(path), { isSubscription: false });
  });

  it("SHOULD report false WHEN top-level value is not an object", () => {
    const path = writeClaude("array.json", "[]");
    assert.deepEqual(detectSubscription(path), { isSubscription: false });
  });

  it("SHOULD report false WHEN top-level is null", () => {
    const path = writeClaude("null.json", "null");
    assert.deepEqual(detectSubscription(path), { isSubscription: false });
  });

  it("SHOULD report false WHEN oauthAccount key is missing", () => {
    const path = writeClaude("no-account.json", JSON.stringify({ other: "field" }));
    assert.deepEqual(detectSubscription(path), { isSubscription: false });
  });

  it("SHOULD report false WHEN oauthAccount is not an object", () => {
    const path = writeClaude("bad-account.json", JSON.stringify({ oauthAccount: "yes" }));
    assert.deepEqual(detectSubscription(path), { isSubscription: false });
  });

  it("SHOULD report true WHEN hasAvailableSubscription is true", () => {
    const path = writeClaude(
      "has-sub.json",
      JSON.stringify({ oauthAccount: { hasAvailableSubscription: true } }),
    );
    assert.deepEqual(detectSubscription(path), { isSubscription: true });
  });

  it("SHOULD report true WHEN billingType is 'subscription'", () => {
    const path = writeClaude(
      "billing-sub.json",
      JSON.stringify({ oauthAccount: { billingType: "subscription" } }),
    );
    assert.deepEqual(detectSubscription(path), { isSubscription: true });
  });

  it("SHOULD report false WHEN billingType is 'pay-as-you-go'", () => {
    const path = writeClaude(
      "billing-payg.json",
      JSON.stringify({ oauthAccount: { billingType: "pay-as-you-go" } }),
    );
    assert.deepEqual(detectSubscription(path), { isSubscription: false });
  });

  it("SHOULD report false WHEN hasAvailableSubscription is truthy but not strictly true", () => {
    const path = writeClaude(
      "truthy.json",
      JSON.stringify({ oauthAccount: { hasAvailableSubscription: "yes" } }),
    );
    assert.deepEqual(detectSubscription(path), { isSubscription: false });
  });

  it("SHOULD never expose OAuth tokens or other fields IN the result shape", () => {
    const path = writeClaude(
      "tokens.json",
      JSON.stringify({
        oauthAccount: {
          hasAvailableSubscription: true,
          accessToken: "secret-token-DO-NOT-LEAK",
          refreshToken: "secret-refresh-DO-NOT-LEAK",
        },
      }),
    );
    const result = detectSubscription(path);
    assert.deepEqual(Object.keys(result), ["isSubscription"]);
    assert.equal(JSON.stringify(result).includes("DO-NOT-LEAK"), false);
  });
});

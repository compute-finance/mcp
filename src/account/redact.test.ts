import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, redactError, redactGrant, redactedMessage } from "./redact.js";

const TOKEN = "cfa_live_abcdef0123456789-body";

const DISGUISES: Record<string, string> = {
  verbatim: TOKEN,
  "case-shifted": TOKEN.toUpperCase(),
  "mixed case": "Cfa_Live_abcdef0123456789-body",
  "percent-encoded": TOKEN.replace(/_/g, "%5F"),
  "percent-encoded upper": TOKEN.replace(/_/g, "%5F").toUpperCase(),
  truncated: TOKEN.slice(0, 18),
  "prefix alone": "cfa_live_",
};

describe("redactGrant", () => {
  for (const [shape, echo] of Object.entries(DISGUISES)) {
    it(`SHOULD redact a ${shape} echo — Bug guarded: matching the token by exact substring lets every other rendering of it through`, () => {
      const redacted = redactGrant(`upstream said: Bearer ${echo} was rejected`);
      assert.equal(redacted, `upstream said: Bearer ${REDACTED} was rejected`);
    });
  }

  it("SHOULD leave text that only resembles the prefix alone", () => {
    const untouched = "cfa live tokens are issued per app; the cf_account skill reads them";
    assert.equal(redactGrant(untouched), untouched);
  });
});

describe("redactError", () => {
  it("SHOULD scrub the stack as well as the message — Bug guarded: the stack snapshots the message at construction, so redacting the message alone leaves the token one console.error away", () => {
    const err = new Error(`refused ${TOKEN}`);
    assert.match(err.stack ?? "", /cfa_live_/);

    const redacted = redactError(err);
    assert.equal(redacted.message, `refused ${REDACTED}`);
    assert.doesNotMatch(redacted.stack ?? "", /cfa(?:_|%5f)live/i);
  });

  it("SHOULD scrub a cause chain, since printing an error prints its cause", () => {
    const err = new Error("fetch failed", { cause: new Error(`sent ${TOKEN}`) });
    const cause = redactError(err).cause as Error;
    assert.equal(cause.message, `sent ${REDACTED}`);
  });

  it("SHOULD keep the error's own class and fields, so a caller can still branch on them", () => {
    class Refusal extends Error {
      status = 403;
      constructor() {
        super(`grant ${TOKEN} is frozen`);
      }
    }
    const redacted = redactError(new Refusal());
    assert.ok(redacted instanceof Refusal);
    assert.equal(redacted.status, 403);
    assert.equal(redacted.message, `grant ${REDACTED} is frozen`);
  });

  it("SHOULD render a thrown non-error safely", () => {
    assert.equal(redactedMessage(`plain string carrying ${TOKEN}`), `plain string carrying ${REDACTED}`);
  });
});

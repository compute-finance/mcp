import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  AccountApiError,
  UnsafeCredentialOrigin,
  assertCredentialOrigin,
  callAccountTool,
  listAccountTools,
} from "./client.js";

const TOKEN = "cfa_live_client-test-token";

interface Capture {
  url: string;
  init: RequestInit | undefined;
}

let originalFetch: typeof globalThis.fetch;
let captures: Capture[];

function serve(status: number, body: unknown): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    captures.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

const DISCOVERY = {
  appName: "Acme CLI",
  context: { orgId: "org_1", orgName: "Acme", role: "ADMIN" },
  tools: [
    {
      name: "account.overview",
      description: "Balance, caps and the money rail.",
      scope: "account:read",
      minimumOrgRole: null,
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  captures = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("listAccountTools", () => {
  it("SHOULD carry the grant as a bearer token and read the discovery document back", async () => {
    serve(200, DISCOVERY);
    const document = await listAccountTools(TOKEN);

    assert.equal(captures.length, 1);
    assert.ok(captures[0].url.endsWith("/v1/account-tools"), captures[0].url);
    assert.equal(headerValue(captures[0].init, "authorization"), `Bearer ${TOKEN}`);
    assert.equal(document.appName, "Acme CLI");
    assert.deepEqual(document.context, { orgId: "org_1", orgName: "Acme", role: "ADMIN" });
    assert.deepEqual(document.tools[0].inputSchema, { type: "object", properties: {} });
  });

  it("SHOULD drop an entry the document cannot describe rather than registering a nameless tool", async () => {
    serve(200, { ...DISCOVERY, tools: [...DISCOVERY.tools, { description: "no name" }] });
    const document = await listAccountTools(TOKEN);
    assert.deepEqual(
      document.tools.map((tool) => tool.name),
      ["account.overview"],
    );
  });

  it("SHOULD reject a document with no tools array — Bug guarded: an unrecognised body must not register as an account with zero tools", async () => {
    serve(200, { appName: "Acme CLI" });
    await assert.rejects(() => listAccountTools(TOKEN), /tools array/);
  });
});

describe("a refusal from the exchange", () => {
  const REFUSALS = [
    {
      status: 401,
      code: "invalid_app_grant",
      message: "Invalid app grant token",
    },
    {
      status: 403,
      code: "app_grant_frozen",
      message: "This app grant is frozen",
    },
    {
      status: 401,
      code: "app_grant_revoked",
      message: "This app grant has been revoked",
    },
    {
      status: 403,
      code: "forbidden",
      message:
        'The "account.keys" tool needs account:read access, which this caller does not hold ' +
        "(held: account:act). Nothing about the account was read.",
    },
  ];

  for (const refusal of REFUSALS) {
    it(`SHOULD surface the exchange's own wording for ${refusal.code} — Bug guarded: a refusal rewritten locally reads as an account with nothing in it`, async () => {
      serve(refusal.status, {
        error: { message: refusal.message, type: "forbidden", code: refusal.code },
      });
      await assert.rejects(
        () => callAccountTool(TOKEN, "account.keys", {}),
        (err: unknown) => {
          assert.ok(err instanceof AccountApiError);
          assert.equal(err.message, refusal.message);
          assert.equal(err.code, refusal.code);
          assert.equal(err.status, refusal.status);
          return true;
        },
      );
    });
  }

  it("SHOULD name the status IF the body carries no message, rather than answering with a result", async () => {
    serve(502, "<html>bad gateway</html>");
    await assert.rejects(
      () => listAccountTools(TOKEN),
      (err: unknown) => err instanceof AccountApiError && /returned 502/.test(err.message),
    );
  });
});

describe("the origin the credential may be sent to", () => {
  const ALLOWED = [
    "https://api.compute.finance",
    "https://api.staging.compute.finance:8443",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ];

  const REFUSED = [
    "http://api.compute.finance",
    "http://compute.finance.evil.test",
    "http://192.168.1.10:3000",
    "http://localhost.evil.test",
    "ftp://api.compute.finance",
    "not a url at all",
  ];

  for (const base of ALLOWED) {
    it(`SHOULD allow ${base}`, () => {
      assert.equal(assertCredentialOrigin(base), base);
    });
  }

  for (const base of REFUSED) {
    it(`SHOULD refuse ${base} — Bug guarded: CF_API_BASE existed for the anonymous oracle, where pointing it anywhere cost nothing; the bearer must not follow it`, () => {
      assert.throws(() => assertCredentialOrigin(base), UnsafeCredentialOrigin);
    });
  }

  it("SHOULD refuse before any request is made, so the token is never put on the wire", async () => {
    const base = process.env.CF_API_BASE;
    process.env.CF_API_BASE = "http://grant-thief.test";
    serve(200, DISCOVERY);
    try {
      await assert.rejects(
        () => listAccountTools(TOKEN),
        (err: unknown) => err instanceof UnsafeCredentialOrigin,
      );
      assert.deepEqual(captures, []);
    } finally {
      if (base === undefined) delete process.env.CF_API_BASE;
      else process.env.CF_API_BASE = base;
    }
  });
});

describe("discovery", () => {
  it("SHOULD give up rather than hang — Bug guarded: an unbounded startup call takes the public oracle and local session tools down with the API", async () => {
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
      })) as typeof globalThis.fetch;

    await assert.rejects(() => listAccountTools(TOKEN, 20), /abort/i);
  });
});

describe("callAccountTool", () => {
  it("SHOULD post the tool name and input, and answer with the result alone", async () => {
    serve(200, { tool: "account.spend", result: { rows: { items: [], total: 0 } } });
    const result = await callAccountTool(TOKEN, "account.spend", {
      breakdown: "model",
      period: "month",
    });

    assert.equal(captures[0].init?.method, "POST");
    assert.ok(captures[0].url.endsWith("/v1/account-tools/call"), captures[0].url);
    assert.deepEqual(JSON.parse(String(captures[0].init?.body)), {
      tool: "account.spend",
      input: { breakdown: "model", period: "month" },
    });
    assert.deepEqual(result, { rows: { items: [], total: 0 } });
  });

  it("SHOULD reject an answer carrying no result — Bug guarded: undefined served as a result is indistinguishable from an account that answered nothing", async () => {
    serve(200, { tool: "account.spend" });
    await assert.rejects(() => callAccountTool(TOKEN, "account.spend", {}), /without a result/);
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_NOT_CONNECTED,
  accountGroupFrom,
  isAccountToolName,
  loadAccountGroup,
  mcpToolName,
} from "./group.js";
import {
  AccountApiError,
  type AccountToolDescriptor,
  type AccountToolsDocument,
} from "./client.js";
import { SecretStoreFailure } from "./os-store.js";
import { toolDefinitions } from "../tools/definitions.js";

const TOKEN = "cfa_live_group-test-token";

const DOCUMENT: AccountToolsDocument = {
  appName: "Acme CLI",
  context: null,
  tools: [
    {
      name: "account.overview",
      description: "Balance, caps and the money rail.",
      scope: "account:read",
      minimumOrgRole: null,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "account.set_budget_caps",
      description: "Set or clear the daily, weekly and monthly caps.",
      scope: "account:act",
      minimumOrgRole: "ADMIN",
      inputSchema: {
        type: "object",
        properties: { dailyWei: { type: "string" } },
        required: ["dailyWei"],
      },
    },
  ],
};

let originalFetch: typeof globalThis.fetch;
let originalStderr: typeof process.stderr.write;
let warnings: string[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalStderr = process.stderr.write.bind(process.stderr);
  warnings = [];
  process.stderr.write = ((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stderr.write = originalStderr;
});

describe("mcpToolName", () => {
  it("SHOULD turn the exchange's dotted name into one an MCP client will accept", () => {
    assert.equal(mcpToolName("account.overview"), "account_overview");
    assert.equal(mcpToolName("account.set_budget_caps"), "account_set_budget_caps");
    assert.equal(mcpToolName("keys.list"), "account_keys_list");
    assert.ok(isAccountToolName(mcpToolName("account.overview")));
  });
});

describe("the account group", () => {
  it("SHOULD take every name, description and schema from the discovery document — Bug guarded: a locally declared schema goes stale the moment the exchange changes one", () => {
    const group = accountGroupFrom(TOKEN, DOCUMENT);

    assert.deepEqual(
      group.tools.map((tool) => tool.name),
      ["account_overview", "account_set_budget_caps"],
    );
    group.tools.forEach((tool, i) => {
      assert.deepEqual(tool.inputSchema, DOCUMENT.tools[i].inputSchema, tool.name);
      assert.ok(
        tool.description.startsWith(DOCUMENT.tools[i].description),
        `${tool.name} must lead with the exchange's own description`,
      );
    });
  });

  it("SHOULD register whatever the document names, even a tool this package has never heard of — Bug guarded: a hardcoded allowlist leaves a newly published tool unreachable", () => {
    const invented = {
      name: "account.something_shipped_after_this_release",
      description: "Published by the exchange, unknown here.",
      scope: "account:read",
      minimumOrgRole: null,
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    };
    const group = accountGroupFrom(TOKEN, { ...DOCUMENT, tools: [invented] });

    assert.deepEqual(
      group.tools.map((tool) => tool.name),
      ["account_something_shipped_after_this_release"],
    );
    assert.deepEqual(group.tools[0].inputSchema, invented.inputSchema);
  });

  it("SHOULD state the access each tool needs, using the words the document used", () => {
    const [read, act] = accountGroupFrom(TOKEN, DOCUMENT).tools;
    assert.ok(read.description.includes("account:read"));
    assert.ok(!read.description.includes("ADMIN"), "a tool with no role requirement must claim none");
    assert.ok(act.description.includes("account:act"));
    assert.ok(act.description.includes("ADMIN"));
  });

  it("SHOULD name the organization a grant is pinned to IF the document names one", () => {
    const pinned = accountGroupFrom(TOKEN, {
      ...DOCUMENT,
      context: { orgId: "org_1", orgName: "Acme", role: "MEMBER" },
    });
    assert.ok(pinned.tools[0].description.includes("Acme"));
    assert.ok(accountGroupFrom(TOKEN, DOCUMENT).tools[0].description.includes("personal account"));
  });

  it("SHOULD refuse a document whose two tools normalise to one MCP name — Bug guarded: the later entry silently shadows the earlier one, so a call reaches a tool the model never chose", () => {
    const collide = (name: string): AccountToolDescriptor => ({
      ...DOCUMENT.tools[0],
      name,
    });
    assert.throws(
      () => accountGroupFrom(TOKEN, { ...DOCUMENT, tools: [collide("keys.list"), collide("keys/list")] }),
      /account_keys_list/,
    );
  });

  it("SHOULD call the exchange under the tool's own name, not the one the client used", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ tool: "account.overview", result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const result = await accountGroupFrom(TOKEN, DOCUMENT).call("account_overview", {});
    assert.deepEqual(calls, [{ tool: "account.overview", input: {} }]);
    assert.deepEqual(result, { ok: true });
  });
});

describe("loadAccountGroup", () => {
  it("SHOULD register the group WHEN a credential is present", async () => {
    const group = await loadAccountGroup(
      async () => TOKEN,
      async () => DOCUMENT,
    );
    assert.ok(group !== null);
    assert.equal(group.appName, "Acme CLI");
    assert.equal(group.tools.length, 2);
  });

  it("SHOULD register nothing WHEN no credential is present, and never ask the exchange — Bug guarded: an unconnected install must keep the oracle and session tools exactly as they were", async () => {
    let asked = 0;
    const group = await loadAccountGroup(
      async () => null,
      async () => {
        asked += 1;
        return DOCUMENT;
      },
    );
    assert.equal(group, null);
    assert.equal(asked, 0);
  });

  for (const refusal of [
    new AccountApiError("This app grant has been revoked", "app_grant_revoked", 401),
    new AccountApiError("This app grant is frozen", "app_grant_frozen", 403),
  ]) {
    it(`SHOULD keep the exchange's wording reachable WHEN discovery answers ${refusal.status} — Bug guarded: collapsing a refusal to "no account connected" sends the user to setup when the truth is that their grant was revoked`, async () => {
      const group = await loadAccountGroup(
        async () => TOKEN,
        async () => {
          throw refusal;
        },
      );

      assert.ok(group !== null, "a refused grant must not read as an unconnected one");
      assert.deepEqual(
        group.tools.map((tool) => tool.name),
        ["account_status"],
      );
      assert.ok(group.tools[0].description.includes(refusal.message));
      await assert.rejects(
        () => group.call("account_overview", {}),
        (err: Error) => err.message.includes(refusal.message),
      );
      assert.ok(!/No Compute Finance account is connected/.test(group.tools[0].description));
    });
  }

  it("SHOULD refuse an origin the credential may not be sent to, and say so rather than going quiet", async () => {
    const base = process.env.CF_API_BASE;
    process.env.CF_API_BASE = "http://grant-thief.test";
    try {
      const group = await loadAccountGroup(
        async () => TOKEN,
        async () => DOCUMENT,
      );
      assert.ok(group !== null);
      assert.ok(group.tools[0].description.includes("CF_API_BASE"));
      await assert.rejects(
        () => group.call("account_overview", {}),
        (err: Error) => err instanceof Error && /CF_API_BASE/.test(err.message),
      );
    } finally {
      if (base === undefined) delete process.env.CF_API_BASE;
      else process.env.CF_API_BASE = base;
    }
  });

  it("SHOULD check the origin only after a credential is found, so an unconnected install is never warned about one", async () => {
    const base = process.env.CF_API_BASE;
    process.env.CF_API_BASE = "http://grant-thief.test";
    try {
      assert.equal(
        await loadAccountGroup(
          async () => null,
          async () => DOCUMENT,
        ),
        null,
      );
      assert.deepEqual(warnings, []);
    } finally {
      if (base === undefined) delete process.env.CF_API_BASE;
      else process.env.CF_API_BASE = base;
    }
  });

  it("SHOULD register nothing WHEN resolving the credential throws — Bug guarded: a rejection here takes the whole tool list down with it, including the oracle tools that need no credential", async () => {
    const group = await loadAccountGroup(
      async () => {
        throw new SecretStoreFailure("macOS Keychain", "security exited 51");
      },
      async () => DOCUMENT,
    );
    assert.equal(group, null);
    assert.match(warnings.join(""), /macOS Keychain could not be read/);
  });

  it("SHOULD register nothing WHEN the document collides with itself, rather than shadowing one tool with another", async () => {
    const twice = (name: string): AccountToolDescriptor => ({ ...DOCUMENT.tools[0], name });
    const group = await loadAccountGroup(
      async () => TOKEN,
      async () => ({ ...DOCUMENT, tools: [twice("keys.list"), twice("keys/list")] }),
    );
    assert.equal(group, null);
    assert.match(warnings.join(""), /account_keys_list/);
  });
});

describe("the package's own tool declarations", () => {
  it("SHOULD declare no account tool locally — Bug guarded: a copied name or schema here is a second source of truth that can disagree with the exchange", async () => {
    assert.deepEqual(
      toolDefinitions.filter((tool) => isAccountToolName(tool.name)).map((tool) => tool.name),
      [],
    );

    const renamedUpstream = await loadAccountGroup(
      async () => TOKEN,
      async () => ({
        ...DOCUMENT,
        tools: [{ ...DOCUMENT.tools[0], name: "account.renamed_after_this_release" }],
      }),
    );

    assert.deepEqual(
      renamedUpstream?.tools.map((tool) => tool.name),
      ["account_renamed_after_this_release"],
      "the served list must follow the document, so nothing here can outvote it",
    );
  });

  it("SHOULD point an unconnected caller at setup rather than answering for an account", () => {
    assert.match(ACCOUNT_NOT_CONNECTED, /setup --account/);
    assert.ok(!/empty|no balance|nothing/i.test(ACCOUNT_NOT_CONNECTED));
  });
});

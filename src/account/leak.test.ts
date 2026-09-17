import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountGroupFrom, loadAccountGroup } from "./group.js";
import { environmentSource, resolveAppGrant } from "./credential.js";
import { listAccountTools, type AccountToolsDocument } from "./client.js";
import { errorText, text } from "../tools/response.js";

const TOKEN = "cfa_live_this-string-must-never-be-written-anywhere";

const RESEMBLES_A_TOKEN = /cfa(?:_|%5f)live/i;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function assertNothingTokenLike(where: string, ...rendered: string[]): void {
  for (const value of rendered) {
    assert.ok(!value.includes(TOKEN), `${where} carried the token verbatim: ${value}`);
    assert.doesNotMatch(value, RESEMBLES_A_TOKEN, `${where} carried something token-shaped`);
    assert.ok(
      !value.includes("this-string-must-never"),
      `${where} carried the token's body: ${value}`,
    );
  }
}

const DOCUMENT: AccountToolsDocument = {
  appName: "Acme CLI",
  context: null,
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

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

let originalFetch: typeof globalThis.fetch;
let savedEnv: Record<string, string | undefined>;
let sandbox: string;
let written: string[];
let restoreStreams: () => void;

function captureStreams(): void {
  written = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const record =
    (forward: (chunk: never, ...rest: never[]) => boolean) =>
    (chunk: never, ...rest: never[]): boolean => {
      written.push(String(chunk));
      return forward(chunk, ...rest);
    };
  process.stdout.write = record(stdout) as typeof process.stdout.write;
  process.stderr.write = record(stderr) as typeof process.stderr.write;
  restoreStreams = () => {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sandbox = mkdtempSync(join(tmpdir(), "cf-mcp-leak-"));
  savedEnv = {
    HOME: process.env.HOME,
    APPDATA: process.env.APPDATA,
    COMPUTE_FINANCE_DIR: process.env.COMPUTE_FINANCE_DIR,
    CF_APP_GRANT: process.env.CF_APP_GRANT,
    CF_APP_GRANT_COMMAND: process.env.CF_APP_GRANT_COMMAND,
  };
  process.env.HOME = sandbox;
  process.env.APPDATA = sandbox;
  process.env.COMPUTE_FINANCE_DIR = join(sandbox, ".compute-finance");
  process.env.CF_APP_GRANT = TOKEN;
  delete process.env.CF_APP_GRANT_COMMAND;
  captureStreams();
});

afterEach(() => {
  restoreStreams();
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe("the credential's blast radius", () => {
  it("SHOULD reach the Authorization header and nothing else — Bug guarded: a token echoed to a stream or spilled into a cache file is readable in a transcript or on disk forever", async () => {
    const seenHeaders: string[] = [];
    const seenBodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenHeaders.push(JSON.stringify(headers));
      seenBodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ tool: "account.overview", result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const token = await resolveAppGrant([environmentSource()]);
    assert.equal(token, TOKEN);

    const group = accountGroupFrom(token!, DOCUMENT);
    const result = await group.call("account_overview", {});

    assert.ok(
      seenHeaders.every((headers) => headers.includes(TOKEN)),
      "the token must ride the Authorization header",
    );
    assertNothingTokenLike(
      "the request body, the advertised tools or a tool answer",
      seenBodies.join(""),
      JSON.stringify(group.tools),
      JSON.stringify(text(result)),
    );
    assertNothingTokenLike("stdout/stderr", written.join(""));
    assert.deepEqual(
      filesUnder(sandbox).filter((path) => RESEMBLES_A_TOKEN.test(readFileSync(path, "utf-8"))),
      [],
    );
  });

  it("SHOULD keep every disguise of the token out of the warning it prints WHEN discovery fails — Bug guarded: an exact-substring redactor lets a truncated, percent-encoded or case-shifted echo through", async () => {
    globalThis.fetch = (async () => {
      throw new Error(
        `connect ECONNREFUSED while sending Bearer ${TOKEN.toUpperCase()} ` +
          `(logged as ${TOKEN.replace(/_/g, "%5F")}, truncated to ${TOKEN.slice(0, 24)})`,
      );
    }) as typeof globalThis.fetch;

    const group = await loadAccountGroup(async () => TOKEN, listAccountTools);
    assert.equal(group, null);
    assert.ok(written.length > 0, "a failed discovery must say so on stderr");
    assertNothingTokenLike("the startup warning", written.join(""));
    assert.deepEqual(
      filesUnder(sandbox).filter((path) => RESEMBLES_A_TOKEN.test(readFileSync(path, "utf-8"))),
      [],
    );
  });

  it("SHOULD scrub the stack a thrown error was constructed with — Bug guarded: once the stack has been formatted it holds the pre-redaction message, so a later console.error re-leaks it", async () => {
    globalThis.fetch = (async () => {
      const err = new Error(`socket hang up (sent ${TOKEN})`);
      assert.match(err.stack ?? "", /cfa_live_/, "the stack must start out carrying the token");
      throw err;
    }) as typeof globalThis.fetch;

    const failure = await accountGroupFrom(TOKEN, DOCUMENT)
      .call("account_overview", {})
      .catch((err: Error) => err);

    assert.ok(failure instanceof Error);
    assertNothingTokenLike("the thrown error", failure.message, failure.stack ?? "");
  });

  it("SHOULD keep the token out of a refusal handed back to the model", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "This app grant is frozen",
            type: "forbidden",
            code: "app_grant_frozen",
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;

    const group = accountGroupFrom(TOKEN, DOCUMENT);
    const refusal = await group.call("account_overview", {}).catch((err: Error) => err.message);
    const rendered = JSON.stringify(errorText(String(refusal)));

    assert.ok(rendered.includes("This app grant is frozen"));
    assert.ok(!rendered.includes(TOKEN));
  });

  it("SHOULD keep the token out of a transport failure handed back to the model — Bug guarded: the model's answer is written into a transcript, so a bearer inside a thrown message outlives the session", async () => {
    globalThis.fetch = (async () => {
      throw new Error(`socket hang up (sent Bearer ${TOKEN.replace(/_/g, "%5F")})`);
    }) as typeof globalThis.fetch;

    const group = accountGroupFrom(TOKEN, DOCUMENT);
    const refusal = await group.call("account_overview", {}).catch((err: Error) => err.message);
    const rendered = JSON.stringify(errorText(String(refusal)));

    assert.ok(rendered.includes("socket hang up"), "the failure must still be reported");
    assertNothingTokenLike("a tool refusal", rendered);
  });
});

describe("setup's own output", () => {
  it("SHOULD print no form of the token WHEN the exchange refuses the grant it was handed — Bug guarded: setup renders an upstream message straight to a terminal and a shell history file", async () => {
    const quoted =
      `Invalid app grant token ${TOKEN.toUpperCase()} ` +
      `(seen as ${TOKEN.replace(/_/g, "%5F")}, prefix ${TOKEN.slice(0, 24)})`;
    const server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: quoted, type: "invalid_request_error" } }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    const noPath = mkdtempSync(join(tmpdir(), "cf-mcp-nopath-"));

    try {
      const printed = await new Promise<{ code: number | null; output: string }>((done) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", join(repoRoot, "src", "setup.ts"), "--account"],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              PATH: noPath,
              CF_API_BASE: `http://127.0.0.1:${port}`,
              CF_APP_GRANT: undefined,
            },
          },
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on("close", (code) => done({ code, output }));
        child.stdin.end(`${TOKEN}\n`);
      });

      assert.equal(printed.code, 1, printed.output);
      assert.match(printed.output, /refused this grant/);
      assertNothingTokenLike("setup's output", printed.output);
    } finally {
      rmSync(noPath, { recursive: true, force: true });
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

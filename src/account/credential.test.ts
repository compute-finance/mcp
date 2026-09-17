import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  commandSource,
  credentialSources,
  environmentSource,
  firstLine,
  osStoreSource,
  resolveAppGrant,
  type CredentialSource,
} from "./credential.js";
import { SecretStoreFailure } from "./os-store.js";
import type { RunOptions, SecretRunner } from "./spawn.js";

const TOKEN = "cfa_live_only-the-resolver-should-see-this";

interface Invocation {
  file: string;
  args: string[];
  options?: RunOptions;
}

function recordingRunner(
  answer: (invocation: Invocation) => { ok: boolean; stdout: string; code?: number },
): { run: SecretRunner; calls: Invocation[] } {
  const calls: Invocation[] = [];
  const run: SecretRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    const { ok, stdout, code } = answer({ file, args, options });
    return { ok, stdout, code: code ?? (ok ? 0 : 1), stderr: "" };
  };
  return { run, calls };
}

function answering(name: string, token: string): CredentialSource {
  return { name, read: async () => token };
}

function silent(name: string): CredentialSource {
  return { name, read: async () => null };
}

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    CF_APP_GRANT: process.env.CF_APP_GRANT,
    CF_APP_GRANT_COMMAND: process.env.CF_APP_GRANT_COMMAND,
  };
  delete process.env.CF_APP_GRANT;
  delete process.env.CF_APP_GRANT_COMMAND;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("firstLine", () => {
  it("SHOULD take the first non-empty line and trim it IF a helper prints a trailing newline", () => {
    assert.equal(firstLine(`${TOKEN}\n`), TOKEN);
    assert.equal(firstLine(`  ${TOKEN}  \r\nnoise\n`), TOKEN);
    assert.equal(firstLine("\n\n"), null);
    assert.equal(firstLine(undefined), null);
  });
});

describe("resolveAppGrant", () => {
  it("SHOULD try command, then OS store, then environment — Bug guarded: a source consulted out of order lets a stale environment variable win over the secret manager the user configured", async () => {
    const consulted: string[] = [];
    const trace = (name: string, token: string | null): CredentialSource => ({
      name,
      read: async () => {
        consulted.push(name);
        return token;
      },
    });

    assert.equal(
      await resolveAppGrant([
        trace("CF_APP_GRANT_COMMAND", null),
        trace("os-store", null),
        trace("CF_APP_GRANT", TOKEN),
      ]),
      TOKEN,
    );
    assert.deepEqual(consulted, ["CF_APP_GRANT_COMMAND", "os-store", "CF_APP_GRANT"]);
  });

  it("SHOULD stop at the first source that answers — Bug guarded: reading every source anyway spawns a secret-manager prompt the user already satisfied", async () => {
    const consulted: string[] = [];
    const trace = (name: string, token: string | null): CredentialSource => ({
      name,
      read: async () => {
        consulted.push(name);
        return token;
      },
    });

    assert.equal(
      await resolveAppGrant([
        trace("CF_APP_GRANT_COMMAND", TOKEN),
        trace("os-store", "other"),
        trace("CF_APP_GRANT", "other"),
      ]),
      TOKEN,
    );
    assert.deepEqual(consulted, ["CF_APP_GRANT_COMMAND"]);
  });

  it("SHOULD answer null IF no source holds a credential", async () => {
    assert.equal(await resolveAppGrant([silent("a"), silent("b")]), null);
  });

  it("SHOULD rethrow the first failure IF no source answered — Bug guarded: a broken keychain swallowed here is indistinguishable from an account that was never connected", async () => {
    const throwing: CredentialSource = {
      name: "os-store",
      read: async () => {
        throw new SecretStoreFailure("macOS Keychain", "security exited 51");
      },
    };
    await assert.rejects(() => resolveAppGrant([throwing, silent("CF_APP_GRANT")]), SecretStoreFailure);
  });

  it("SHOULD keep walking IF a source throws — Bug guarded: a locked keychain must not hide the environment fallback behind an unhandled rejection", async () => {
    const throwing: CredentialSource = {
      name: "os-store",
      read: async () => {
        throw new Error("keychain locked");
      },
    };
    assert.equal(await resolveAppGrant([throwing, answering("CF_APP_GRANT", TOKEN)]), TOKEN);
  });

  it("SHOULD default to the command, store and environment sources in that order", () => {
    assert.deepEqual(
      credentialSources().map((source) => source.name),
      ["CF_APP_GRANT_COMMAND", "os-store", "CF_APP_GRANT"],
    );
  });
});

describe("commandSource", () => {
  it("SHOULD run the configured command through a shell and take its first line", async () => {
    process.env.CF_APP_GRANT_COMMAND = "op read op://Private/cf/token";
    const { run, calls } = recordingRunner(() => ({ ok: true, stdout: `${TOKEN}\n` }));
    assert.equal(await commandSource(run).read(), TOKEN);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, "op read op://Private/cf/token");
    assert.equal(calls[0].options?.shell, true);
  });

  it("SHOULD stay silent IF the variable is unset, so no shell is spawned on a machine that never configured one", async () => {
    const { run, calls } = recordingRunner(() => ({ ok: true, stdout: TOKEN }));
    assert.equal(await commandSource(run).read(), null);
    assert.deepEqual(calls, []);
  });

  it("SHOULD answer null IF the command fails — Bug guarded: a non-zero helper must not have its error text read as a token", async () => {
    process.env.CF_APP_GRANT_COMMAND = "false";
    const { run } = recordingRunner(() => ({ ok: false, stdout: "op: not signed in" }));
    assert.equal(await commandSource(run).read(), null);
  });
});

describe("environmentSource", () => {
  it("SHOULD read CF_APP_GRANT and trim it", async () => {
    process.env.CF_APP_GRANT = `  ${TOKEN}  `;
    assert.equal(await environmentSource().read(), TOKEN);
  });

  it("SHOULD answer null IF the variable is empty", async () => {
    process.env.CF_APP_GRANT = "   ";
    assert.equal(await environmentSource().read(), null);
  });
});

describe("osStoreSource", () => {
  it("SHOULD read the platform's own store and take its first line", async () => {
    const { run, calls } = recordingRunner(() => ({ ok: true, stdout: `${TOKEN}\n` }));
    assert.equal(await osStoreSource(run, "darwin").read(), TOKEN);
    assert.equal(calls[0].file, "security");
  });

  it("SHOULD answer null on a platform with no store, without spawning anything", async () => {
    const { run, calls } = recordingRunner(() => ({ ok: true, stdout: TOKEN }));
    assert.equal(await osStoreSource(run, "freebsd").read(), null);
    assert.deepEqual(calls, []);
  });

  it("SHOULD answer null IF the store holds nothing, so an unconnected install stays quiet", async () => {
    const { run } = recordingRunner(() => ({ ok: false, stdout: "", code: 44 }));
    assert.equal(await osStoreSource(run, "darwin").read(), null);
  });

  it("SHOULD surface a broken store rather than reading it as an empty one", async () => {
    const { run } = recordingRunner(() => ({ ok: false, stdout: "", code: 51 }));
    await assert.rejects(() => osStoreSource(run, "darwin").read(), SecretStoreFailure);
  });
});

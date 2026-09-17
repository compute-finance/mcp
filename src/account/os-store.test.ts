import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SecretStoreFailure, SecretStoreUnavailable, secretStoreFor } from "./os-store.js";
import type { RunOptions, SecretRunner } from "./spawn.js";

const TOKEN = "cfa_live_never-put-me-in-argv";

const PLATFORMS = ["darwin", "win32", "linux"] as const;

interface Invocation {
  file: string;
  args: string[];
  options?: RunOptions;
}

function recorder(
  ok = true,
  stdout = "",
  code: number | null = ok ? 0 : 1,
  stderr = "",
): { run: SecretRunner; calls: Invocation[] } {
  const calls: Invocation[] = [];
  const run: SecretRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    return { ok, code, stdout, stderr };
  };
  return { run, calls };
}

describe("secretStoreFor", () => {
  it("SHOULD hand back the store the platform already ships", () => {
    assert.equal(secretStoreFor("darwin", recorder().run)?.describe, "macOS Keychain");
    assert.equal(secretStoreFor("win32", recorder().run)?.describe, "Windows DPAPI");
    assert.equal(
      secretStoreFor("linux", recorder().run)?.describe,
      "the Secret Service (secret-tool)",
    );
  });

  it("SHOULD answer null on a platform with no store it can use, so setup refuses rather than inventing a file", () => {
    assert.equal(secretStoreFor("freebsd", recorder().run), null);
    assert.equal(secretStoreFor("aix", recorder().run), null);
  });
});

describe("storing a token", () => {
  for (const platform of PLATFORMS) {
    it(`SHOULD keep the token out of the process arguments on ${platform} — Bug guarded: a secret passed in argv is readable by every process on the machine`, async () => {
      const { run, calls } = recorder();
      await secretStoreFor(platform, run)!.write(TOKEN);

      assert.ok(calls.length > 0, "write must spawn the platform helper");
      for (const call of calls) {
        assert.ok(!call.file.includes(TOKEN), `${platform}: token is in the command name`);
        for (const arg of call.args) {
          assert.ok(!arg.includes(TOKEN), `${platform}: token is in an argument (${arg})`);
        }
      }
    });

    it(`SHOULD hand the token to ${platform}'s helper on stdin`, async () => {
      const { run, calls } = recorder();
      await secretStoreFor(platform, run)!.write(TOKEN);
      assert.ok(
        calls.some((call) => call.options?.input?.includes(TOKEN)),
        `${platform}: no spawned helper was fed the token`,
      );
    });

    it(`SHOULD refuse IF ${platform}'s helper fails — Bug guarded: a store that swallowed the failure leaves setup reporting success over nothing stored`, async () => {
      const { run } = recorder(false);
      await assert.rejects(
        () => secretStoreFor(platform, run)!.write(TOKEN),
        (err: Error) => err instanceof SecretStoreUnavailable,
      );
    });
  }
});

describe("reading a token", () => {
  it("SHOULD answer with the helper's stdout IF it succeeds", async () => {
    for (const platform of PLATFORMS) {
      const { run } = recorder(true, TOKEN);
      assert.equal(await secretStoreFor(platform, run)!.read(), TOKEN, platform);
    }
  });

  const MISSES = {
    darwin: recorder(false, "", 44),
    win32: recorder(false, "", 44),
    linux: recorder(false, "", 1),
  } as const;

  for (const platform of PLATFORMS) {
    it(`SHOULD stay quiet on ${platform} IF nothing is stored — Bug guarded: a real miss reported as a broken store warns every install that never connected an account`, async () => {
      assert.equal(await secretStoreFor(platform, MISSES[platform].run)!.read(), null);
    });
  }

  const BREAKAGES = {
    darwin: recorder(false, "", 51, "SecKeychain: interaction not allowed"),
    win32: recorder(false, "", 1, "Key not valid for use in specified state"),
    linux: recorder(false, "", 1, "secret-tool: cannot autolaunch D-Bus"),
  } as const;

  for (const platform of PLATFORMS) {
    it(`SHOULD say what went wrong on ${platform} IF the store itself failed — Bug guarded: a locked keychain read as "no credential stored" sends the user to setup for a token that is already there`, async () => {
      await assert.rejects(
        () => secretStoreFor(platform, BREAKAGES[platform].run)!.read(),
        (err: Error) => err instanceof SecretStoreFailure && /could not be read/.test(err.message),
      );
    });
  }

  it("SHOULD never read an error message as a token", async () => {
    for (const platform of PLATFORMS) {
      const { run } = recorder(false, "secret-tool: cannot autolaunch D-Bus", 1, "boom");
      const read = await secretStoreFor(platform, run)!.read().catch(() => null);
      assert.equal(read, null, platform);
    }
  });
});

describe("windows blob", () => {
  it("SHOULD name the encrypted blob through an environment variable rather than the script text", async () => {
    const { run, calls } = recorder();
    await secretStoreFor("win32", run)!.write(TOKEN);
    const script = calls[0].args.join(" ");
    assert.ok(script.includes("ConvertFrom-SecureString"), "must encrypt with DPAPI");
    assert.ok(
      script.includes("$env:CF_MCP_GRANT_BLOB"),
      "the path must come from the environment, not be spliced into the script",
    );
    assert.equal(typeof calls[0].options?.env?.CF_MCP_GRANT_BLOB, "string");
  });

  it("SHOULD write and read the blob without a trailing newline — Bug guarded: ConvertTo-SecureString rejects the newline Set-Content appends, so a stored token reads back as a broken store", async () => {
    const write = recorder();
    await secretStoreFor("win32", write.run)!.write(TOKEN);
    assert.match(write.calls[0].args.join(" "), /Set-Content[^;]*-NoNewline/);

    const read = recorder(true, TOKEN);
    await secretStoreFor("win32", read.run)!.read();
    const script = read.calls[0].args.join(" ");
    assert.match(script, /Get-Content[^;]*-Raw\)\.Trim\(\)/);
    assert.match(script, /exit 44/);
  });
});

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runCapturing } from "./spawn.js";

const TOKEN = "cfa_live_must-never-reach-a-child-process";

const REPORT_ENV =
  "process.stdout.write(JSON.stringify({" +
  "grant: process.env.CF_APP_GRANT ?? null," +
  "passed: process.env.CF_MCP_GRANT_BLOB ?? null," +
  "inherited: Boolean(process.env.PATH)}))";

afterEach(() => {
  delete process.env.CF_APP_GRANT;
});

describe("runCapturing", () => {
  it("SHOULD strip CF_APP_GRANT from the child while leaving the rest of the environment — Bug guarded: security, powershell and the user's own helper command all inherit process.env and can log what they were handed", async () => {
    process.env.CF_APP_GRANT = TOKEN;

    const { ok, stdout } = await runCapturing(process.execPath, ["-e", REPORT_ENV], {
      env: { CF_MCP_GRANT_BLOB: "/tmp/blob" },
    });

    assert.ok(ok, stdout);
    assert.deepEqual(JSON.parse(stdout), {
      grant: null,
      passed: "/tmp/blob",
      inherited: true,
    });
  });

  it("SHOULD report the exit code and stderr so a caller can tell a miss from a broken store", async () => {
    const result = await runCapturing(process.execPath, [
      "-e",
      "process.stderr.write('cannot autolaunch D-Bus'); process.exit(44)",
    ]);

    assert.equal(result.ok, false);
    assert.equal(result.code, 44);
    assert.match(result.stderr, /autolaunch D-Bus/);
  });

  it("SHOULD answer with no exit code IF the helper cannot be started at all", async () => {
    const result = await runCapturing("cf-no-such-helper-anywhere", ["lookup"]);
    assert.equal(result.ok, false);
    assert.equal(result.code, null);
  });
});

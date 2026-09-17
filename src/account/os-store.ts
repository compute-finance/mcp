import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCapturing, type RunResult, type SecretRunner } from "./spawn.js";

const SERVICE = "compute-finance-mcp";
const ACCOUNT = "app-grant";
const LABEL = "Compute Finance app grant";

const NOT_STORED_EXIT = 44;

export class SecretStoreUnavailable extends Error {
  constructor(store: string) {
    super(`${store} did not accept the token`);
    this.name = "SecretStoreUnavailable";
  }
}

export class SecretStoreFailure extends Error {
  constructor(store: string, detail: string) {
    super(
      `${store} could not be read (${detail}). Unlock it, or set CF_APP_GRANT_COMMAND ` +
        "to a command that prints the grant on stdout.",
    );
    this.name = "SecretStoreFailure";
  }
}

export interface SecretStore {
  readonly describe: string;
  readonly requires: string;
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

function detailOf(result: RunResult, helper: string): string {
  return result.stderr.trim() || `${helper} exited ${result.code}`;
}

function macStore(run: SecretRunner): SecretStore {
  const locator = ["-a", ACCOUNT, "-s", SERVICE];
  const describe = "macOS Keychain";
  return {
    describe,
    requires: "the security command that ships with macOS",
    read: async () => {
      const result = await run("security", ["find-generic-password", ...locator, "-w"]);
      if (result.ok) return result.stdout;
      if (result.code === NOT_STORED_EXIT) return null;
      throw new SecretStoreFailure(describe, detailOf(result, "security"));
    },
    write: async (token) => {
      const { ok } = await run(
        "security",
        ["add-generic-password", ...locator, "-l", LABEL, "-U", "-w"],
        { input: `${token}\n${token}\n` },
      );
      if (!ok) throw new SecretStoreUnavailable(describe);
    },
    clear: async () => {
      await run("security", ["delete-generic-password", ...locator]);
    },
  };
}

function linuxStore(run: SecretRunner): SecretStore {
  const locator = ["service", SERVICE, "account", ACCOUNT];
  const describe = "the Secret Service (secret-tool)";
  return {
    describe,
    requires: "secret-tool from libsecret and a running Secret Service (GNOME Keyring, KWallet)",
    read: async () => {
      const result = await run("secret-tool", ["lookup", ...locator]);
      if (result.ok) return result.stdout;
      if (result.code === 1 && !result.stderr.trim()) return null;
      throw new SecretStoreFailure(describe, detailOf(result, "secret-tool"));
    },
    write: async (token) => {
      const { ok } = await run("secret-tool", ["store", `--label=${LABEL}`, ...locator], {
        input: token,
      });
      if (!ok) throw new SecretStoreUnavailable(describe);
    },
    clear: async () => {
      await run("secret-tool", ["clear", ...locator]);
    },
  };
}

export function windowsBlobPath(): string {
  const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(roaming, "compute-finance", "app-grant.dpapi");
}

const DPAPI_WRITE = [
  "$ErrorActionPreference='Stop'",
  "$token=[Console]::In.ReadLine()",
  "$dir=Split-Path -Parent $env:CF_MCP_GRANT_BLOB",
  "if(-not (Test-Path $dir)){New-Item -ItemType Directory -Path $dir -Force | Out-Null}",
  "ConvertTo-SecureString -String $token -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -Path $env:CF_MCP_GRANT_BLOB -Encoding ascii -NoNewline",
].join("; ");

const DPAPI_READ = [
  "$ErrorActionPreference='Stop'",
  `if(-not (Test-Path $env:CF_MCP_GRANT_BLOB)){exit ${NOT_STORED_EXIT}}`,
  "$blob=(Get-Content -Path $env:CF_MCP_GRANT_BLOB -Raw).Trim()",
  `if(-not $blob){exit ${NOT_STORED_EXIT}}`,
  "$secure=ConvertTo-SecureString $blob",
  "[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))",
].join("; ");

function powershell(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

function windowsStore(run: SecretRunner): SecretStore {
  const describe = "Windows DPAPI";
  const blobEnv = () => ({ CF_MCP_GRANT_BLOB: windowsBlobPath() });
  return {
    describe,
    requires: "powershell, which ships with Windows",
    read: async () => {
      const result = await run("powershell", powershell(DPAPI_READ), { env: blobEnv() });
      if (result.ok) return result.stdout;
      if (result.code === NOT_STORED_EXIT) return null;
      throw new SecretStoreFailure(describe, detailOf(result, "powershell"));
    },
    write: async (token) => {
      const { ok } = await run("powershell", powershell(DPAPI_WRITE), {
        env: blobEnv(),
        input: `${token}\n`,
      });
      if (!ok) throw new SecretStoreUnavailable(describe);
    },
    clear: async () => {
      const path = windowsBlobPath();
      if (existsSync(path)) unlinkSync(path);
    },
  };
}

export function secretStoreFor(
  platform: NodeJS.Platform = process.platform,
  run: SecretRunner = runCapturing,
): SecretStore | null {
  if (platform === "darwin") return macStore(run);
  if (platform === "win32") return windowsStore(run);
  if (platform === "linux") return linuxStore(run);
  return null;
}

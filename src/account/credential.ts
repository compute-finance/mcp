import { secretStoreFor } from "./os-store.js";
import { runCapturing, type SecretRunner } from "./spawn.js";

export interface CredentialSource {
  readonly name: string;
  read(): Promise<string | null>;
}

export function firstLine(raw: string | null | undefined): string | null {
  if (!raw) return null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function commandSource(run: SecretRunner = runCapturing): CredentialSource {
  return {
    name: "CF_APP_GRANT_COMMAND",
    read: async () => {
      const command = process.env.CF_APP_GRANT_COMMAND?.trim();
      if (!command) return null;
      const { ok, stdout } = await run(command, [], { shell: true });
      return ok ? firstLine(stdout) : null;
    },
  };
}

export function osStoreSource(
  run: SecretRunner = runCapturing,
  platform: NodeJS.Platform = process.platform,
): CredentialSource {
  return {
    name: "os-store",
    read: async () => {
      const store = secretStoreFor(platform, run);
      return store ? firstLine(await store.read()) : null;
    },
  };
}

export function environmentSource(): CredentialSource {
  return {
    name: "CF_APP_GRANT",
    read: async () => firstLine(process.env.CF_APP_GRANT),
  };
}

export function credentialSources(run: SecretRunner = runCapturing): CredentialSource[] {
  return [commandSource(run), osStoreSource(run), environmentSource()];
}

export async function resolveAppGrant(
  sources: CredentialSource[] = credentialSources(),
): Promise<string | null> {
  let failure: unknown = null;
  for (const source of sources) {
    try {
      const token = await source.read();
      if (token) return token;
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) throw failure;
  return null;
}

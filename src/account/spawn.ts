import { spawn } from "node:child_process";

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  input?: string;
  env?: Record<string, string>;
  shell?: boolean;
  timeoutMs?: number;
}

export type SecretRunner = (
  file: string,
  args: string[],
  options?: RunOptions,
) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 10_000;

function childEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  delete env.CF_APP_GRANT;
  return env;
}

export const runCapturing: SecretRunner = (file, args, options = {}) =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(file, args, {
      shell: options.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: childEnv(options.env),
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err: Error) =>
      resolve({ ok: false, code: null, stdout: "", stderr: err.message }),
    );
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });

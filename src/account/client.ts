import { API_BASE } from "../oracle/client.js";

const DISCOVERY_PATH = "/v1/account-tools";
const CALL_PATH = "/v1/account-tools/call";
const DISCOVERY_TIMEOUT_MS = 10_000;

export interface AccountToolDescriptor {
  name: string;
  description: string;
  scope: string;
  minimumOrgRole: string | null;
  inputSchema: Record<string, unknown>;
}

export interface AccountContext {
  orgId: string;
  orgName: string;
  role: string;
}

export interface AccountToolsDocument {
  appName: string;
  context: AccountContext | null;
  tools: AccountToolDescriptor[];
}

export class AccountApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
    this.name = "AccountApiError";
  }
}

export class UnsafeCredentialOrigin extends Error {
  constructor(base: string) {
    super(
      `Refusing to send the app grant to ${base}. CF_API_BASE must be an https origin, ` +
        "or http on a loopback host for local development.",
    );
    this.name = "UnsafeCredentialOrigin";
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.startsWith("127.")
  );
}

function configuredBase(): string {
  return process.env.CF_API_BASE?.trim() || API_BASE;
}

export function assertCredentialOrigin(base: string = configuredBase()): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new UnsafeCredentialOrigin(base);
  }
  if (url.protocol === "https:") return base;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return base;
  throw new UnsafeCredentialOrigin(base);
}

function toApiError(body: unknown, status: number, path: string): AccountApiError {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  const message = typeof error?.message === "string" && error.message ? error.message : null;
  const code = typeof error?.code === "string" ? error.code : null;
  return new AccountApiError(
    message ?? `Compute Finance ${path} returned ${status}`,
    code,
    status,
  );
}

interface RequestOptions {
  body?: unknown;
  timeoutMs?: number;
}

async function request(
  token: string,
  path: string,
  { body, timeoutMs }: RequestOptions = {},
): Promise<unknown> {
  const res = await fetch(`${assertCredentialOrigin()}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) throw toApiError(parsed, res.status, path);
  return parsed;
}

function isDescriptor(value: unknown): value is AccountToolDescriptor {
  const tool = value as Record<string, unknown> | null;
  return (
    typeof tool?.name === "string" &&
    tool.name.length > 0 &&
    typeof tool.description === "string" &&
    typeof tool.inputSchema === "object" &&
    tool.inputSchema !== null
  );
}

function toContext(value: unknown): AccountContext | null {
  const context = value as Record<string, unknown> | null;
  if (typeof context?.orgId !== "string" || typeof context.orgName !== "string") return null;
  return {
    orgId: context.orgId,
    orgName: context.orgName,
    role: typeof context.role === "string" ? context.role : "",
  };
}

function toDocument(body: unknown): AccountToolsDocument {
  const doc = body as Record<string, unknown> | null;
  if (!Array.isArray(doc?.tools)) {
    throw new Error(`${DISCOVERY_PATH} did not answer with a tools array`);
  }
  return {
    appName: typeof doc.appName === "string" ? doc.appName : "",
    context: toContext(doc.context),
    tools: doc.tools.filter(isDescriptor).map((tool) => ({
      name: tool.name,
      description: tool.description,
      scope: typeof tool.scope === "string" ? tool.scope : "",
      minimumOrgRole: typeof tool.minimumOrgRole === "string" ? tool.minimumOrgRole : null,
      inputSchema: tool.inputSchema,
    })),
  };
}

export async function listAccountTools(
  token: string,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<AccountToolsDocument> {
  return toDocument(await request(token, DISCOVERY_PATH, { timeoutMs }));
}

export async function callAccountTool(
  token: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const body = (await request(token, CALL_PATH, { body: { tool, input } })) as Record<
    string,
    unknown
  > | null;
  if (!body || !("result" in body)) {
    throw new Error(`${CALL_PATH} answered without a result for "${tool}"`);
  }
  return body.result;
}

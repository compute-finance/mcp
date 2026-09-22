import type { ToolDef } from "../tools/definitions.js";
import {
  AccountApiError,
  UnsafeCredentialOrigin,
  assertCredentialOrigin,
  callAccountTool,
  listAccountTools,
  type AccountToolDescriptor,
  type AccountToolsDocument,
} from "./client.js";
import { resolveAppGrant } from "./credential.js";
import { redactError, redactGrant, redactedMessage } from "./redact.js";

export const ACCOUNT_TOOL_PREFIX = "account_";

const STATUS_TOOL = `${ACCOUNT_TOOL_PREFIX}status`;

const RECONNECT =
  "Create a new grant in Settings → Connected apps and run `npx @compute-finance/mcp setup --account`.";

export const ACCOUNT_NOT_CONNECTED =
  "No Compute Finance account is connected to this MCP server. " +
  "Create an app grant in Settings → Connected apps, then run `npx @compute-finance/mcp setup --account`.";

export function isAccountToolName(name: string): boolean {
  return name.startsWith(ACCOUNT_TOOL_PREFIX);
}

export function mcpToolName(apiName: string): string {
  const normalized = apiName.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return isAccountToolName(normalized) ? normalized : ACCOUNT_TOOL_PREFIX + normalized;
}

function accessNote(tool: AccountToolDescriptor, document: AccountToolsDocument): string {
  const notes = [
    tool.scope ? `Needs ${tool.scope} access.` : null,
    tool.minimumOrgRole ? `Needs the ${tool.minimumOrgRole} role in the organization.` : null,
    document.context
      ? `Answers for the ${document.context.orgName} organization, which this grant is pinned to.`
      : "Answers for the personal account this grant is pinned to.",
    "The exchange decides what this grant may see; a refusal names the access that is missing and is never an empty answer.",
  ].filter((note): note is string => note !== null);
  return `\n\n${notes.join(" ")}`;
}

function toToolDef(
  name: string,
  tool: AccountToolDescriptor,
  document: AccountToolsDocument,
): ToolDef {
  return {
    name,
    description: tool.description + accessNote(tool, document),
    inputSchema: tool.inputSchema,
  };
}

export interface AccountToolGroup {
  readonly appName: string;
  readonly tools: ToolDef[];
  call(name: string, input: Record<string, unknown>): Promise<unknown>;
}

function indexByMcpName(document: AccountToolsDocument): Map<string, AccountToolDescriptor> {
  const byMcpName = new Map<string, AccountToolDescriptor>();
  for (const tool of document.tools) {
    const name = mcpToolName(tool.name);
    const taken = byMcpName.get(name);
    if (taken) {
      throw new Error(
        `The exchange published "${taken.name}" and "${tool.name}", which both become the MCP tool "${name}". No account tool was registered.`,
      );
    }
    byMcpName.set(name, tool);
  }
  return byMcpName;
}

export function accountGroupFrom(token: string, document: AccountToolsDocument): AccountToolGroup {
  const byMcpName = indexByMcpName(document);

  return {
    appName: document.appName,
    tools: [...byMcpName].map(([name, tool]) => toToolDef(name, tool, document)),
    call: async (name, input) => {
      const tool = byMcpName.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      try {
        return await callAccountTool(token, tool.name, input);
      } catch (err) {
        throw redactError(err);
      }
    },
  };
}

function unreachableAccountGroup(message: string): AccountToolGroup {
  return {
    appName: "",
    tools: [
      {
        name: STATUS_TOOL,
        description: `Reports why the connected Compute Finance account cannot be reached. ${message}`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    call: async () => {
      throw new Error(message);
    },
  };
}

function refusalOf(err: unknown): string | null {
  if (err instanceof AccountApiError && (err.status === 401 || err.status === 403)) {
    return `${redactGrant(err.message)} ${RECONNECT}`;
  }
  if (err instanceof UnsafeCredentialOrigin) return redactedMessage(err);
  return null;
}

export async function loadAccountGroup(
  resolve: () => Promise<string | null> = resolveAppGrant,
  discover: (token: string) => Promise<AccountToolsDocument> = listAccountTools,
): Promise<AccountToolGroup | null> {
  try {
    const token = await resolve();
    if (!token) return null;
    assertCredentialOrigin();
    return accountGroupFrom(token, await discover(token));
  } catch (err) {
    const refusal = refusalOf(err);
    process.stderr.write(`[account] ${refusal ?? `tools unavailable: ${redactedMessage(err)}`}\n`);
    return refusal === null ? null : unreachableAccountGroup(refusal);
  }
}

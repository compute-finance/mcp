/**
 * CLI setup module for `npx @compute-finance/mcp setup`.
 *
 * Dynamically imported from index.ts when `process.argv[2] === "setup"`.
 * Copies skill definitions to ~/.claude/skills/, registers the MCP
 * server with the Claude CLI, and installs the cost hook
 * (UserPromptSubmit) into ~/.claude/settings.json. With `--account`,
 * reads an app grant token on stdin and stores it in the OS credential
 * store instead; `--forget-account` removes it again.
 *
 * Zero extra dependencies — only node: builtins.
 */
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AccountApiError, UnsafeCredentialOrigin, listAccountTools } from "./account/client.js";
import { firstLine } from "./account/credential.js";
import { secretStoreFor } from "./account/os-store.js";
import { redactedMessage } from "./account/redact.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ────────────────────────────────────────────────────────

const SKILL_NAMES = [
  "cf-session-management",
  "cf-session-consumption",
  "cf-active-sessions",
  "cf-account",
] as const;

const PKG_NAME = "@compute-finance/mcp";

// At runtime __dirname is dist/, skills live one level up.
const SKILLS_SRC = join(__dirname, "..", "skills");
const CLAUDE_DIR = join(homedir(), ".claude", "skills");

// ── Flags ────────────────────────────────────────────────────────────

const args = process.argv.slice(2); // strip "node" + script
const skillsOnly = args.includes("--skills-only");
const mcpOnly = args.includes("--mcp-only");
const connectAccountOnly = args.includes("--account");
const forgetAccountOnly = args.includes("--forget-account");

// ── Helpers ──────────────────────────────────────────────────────────

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function hasCli(): boolean {
  try {
    execSync(process.platform === "win32" ? "where claude" : "which claude", {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// ── Account grant ────────────────────────────────────────────────────

async function readHiddenLine(): Promise<string> {
  const stdin = process.stdin;
  const interactive = stdin.isTTY === true;
  if (interactive) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const END_OF_TRANSMISSION = "\u0004";
  const INTERRUPT = "\u0003";
  const BACKSPACE = /[\u0008\u007f]/;

  let typed = "";
  try {
    for await (const chunk of stdin) {
      for (const ch of chunk as string) {
        if (ch === "\r" || ch === "\n" || ch === END_OF_TRANSMISSION) return typed;
        if (ch === INTERRUPT) return "";
        if (BACKSPACE.test(ch)) typed = typed.slice(0, -1);
        else typed += ch;
      }
    }
    return typed;
  } finally {
    if (interactive) stdin.setRawMode(false);
  }
}

function refuseToStore(reason: string): never {
  console.log(red(`  ✗ ${reason}`));
  console.log();
  console.log("  Nothing was written. Point the server at your own secret manager instead:");
  console.log(dim('    export CF_APP_GRANT_COMMAND="op read op://Private/compute-finance/token"'));
  console.log(
    dim("    Any command that prints the token on stdout works — 1Password, pass, Bitwarden."),
  );
  console.log();
  process.exit(1);
}

async function connectAccount(): Promise<void> {
  const store = secretStoreFor();
  if (!store) refuseToStore(`No OS credential store is available on ${process.platform}.`);

  console.log("  Create a grant in Settings → Connected apps, then paste its token below.");
  console.log(dim("  Typing is hidden; the token never lands in a config file or shell history."));
  console.log();
  process.stdout.write("  Token: ");
  const token = firstLine(await readHiddenLine());
  console.log();
  console.log();

  if (!token) {
    console.log(yellow("  ⚠ No token entered — nothing was stored."));
    console.log();
    return;
  }

  try {
    const document = await listAccountTools(token);
    const count = document.tools.length;
    console.log(
      green("  ✓ Grant accepted"),
      dim(`(${document.appName || "unnamed app"}, ${count} account tool${count === 1 ? "" : "s"})`),
    );
  } catch (err) {
    if (err instanceof AccountApiError) {
      console.log(red("  ✗ The exchange refused this grant:"));
      console.log(dim(`    ${redactedMessage(err)}`));
      console.log(dim("    Nothing was stored."));
      console.log();
      process.exit(1);
    }
    if (err instanceof UnsafeCredentialOrigin) refuseToStore(redactedMessage(err));
    console.log(yellow("  ⚠ Could not reach the API to check the token — storing it anyway."));
    console.log(dim(`    ${redactedMessage(err)}`));
  }

  try {
    await store.write(token);
  } catch {
    refuseToStore(`${store.describe} refused the token — it needs ${store.requires}.`);
  }

  console.log(green("  ✓ Token stored in"), dim(store.describe));
  console.log(dim("  Restart Claude Code to pick up the account_* tools."));
  console.log();
}

async function forgetAccount(): Promise<void> {
  const store = secretStoreFor();
  if (!store) {
    console.log(yellow(`  ⚠ No OS credential store on ${process.platform} — nothing to remove.`));
  } else {
    await store.clear();
    console.log(green("  ✓ Removed the stored token from"), dim(store.describe));
  }
  console.log(dim("  Revoking the grant itself is done in Settings → Connected apps."));
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────

console.log();
console.log(bold("  Compute Finance MCP Setup"));
console.log(dim("  ────────────────────────────────────"));
console.log();

if (forgetAccountOnly) {
  await forgetAccount();
  process.exit(0);
}

if (connectAccountOnly) {
  await connectAccount();
  process.exit(0);
}

const installed: string[] = [];
let mcpRegistered = false;

// ── 1. Copy skills ──────────────────────────────────────────────────

if (!mcpOnly) {
  if (!existsSync(SKILLS_SRC)) {
    console.log(
      red("  ✗ skills/ directory not found in package — try reinstalling:"),
    );
    console.log(dim(`    npm install -g ${PKG_NAME}`));
    console.log();
    process.exit(1);
  }

  for (const name of SKILL_NAMES) {
    const src = join(SKILLS_SRC, name, "SKILL.md");
    const destDir = join(CLAUDE_DIR, name);
    const dest = join(destDir, "SKILL.md");

    if (!existsSync(src)) {
      console.log(yellow(`  ⚠ ${name}/SKILL.md missing in package, skipped`));
      continue;
    }

    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, dest);
    console.log(green(`  ✓ ${name}`), dim(`→ ${dest}`));
    installed.push(name);
  }

  console.log();
}

// ── 2. Register MCP server ──────────────────────────────────────────

if (!skillsOnly) {
  if (hasCli()) {
    try {
      execSync(
        `claude mcp add --scope user compute-finance -- npx ${PKG_NAME}`,
        { stdio: "pipe" },
      );
      console.log(green("  ✓ MCP server registered"), dim("(scope: user)"));
      mcpRegistered = true;
    } catch (err) {
      console.log(yellow("  ⚠ Automatic MCP registration failed."));
      console.log(dim(`    Error: ${redactedMessage(err)}`));
      console.log();
      console.log("  Register manually:");
      console.log(
        dim(`    claude mcp add --scope user compute-finance -- npx ${PKG_NAME}`),
      );
    }
  } else {
    console.log(yellow("  ⚠ claude CLI not found on PATH."));
    console.log();
    console.log("  Register the MCP server manually:");
    console.log(
      dim(`    claude mcp add --scope user compute-finance -- npx ${PKG_NAME}`),
    );
  }

  console.log();
}

// ── 3. Install cost hook (UserPromptSubmit) ─────────────────────────

let hookInstalled = false;

if (!mcpOnly) {
  const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
  const HOOK_COMMAND = `npx ${PKG_NAME} hook-prompt`;

  try {
    let settings: Record<string, unknown> = {};
    if (existsSync(SETTINGS_PATH)) {
      try {
        settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
      } catch {
        // Corrupt settings — start fresh object but don't overwrite file yet
        settings = {};
      }
    }

    // Ensure hooks.UserPromptSubmit exists as an array of matcher objects
    if (!settings.hooks || typeof settings.hooks !== "object") {
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown>;
    if (!Array.isArray(hooks.UserPromptSubmit)) {
      hooks.UserPromptSubmit = [];
    }
    const matchers = hooks.UserPromptSubmit as Record<string, unknown>[];

    // Check if our hook is already installed (deep search for command)
    const alreadyInstalled = matchers.some((matcher) => {
      const inner = matcher.hooks;
      if (!Array.isArray(inner)) return false;
      return inner.some(
        (h: Record<string, unknown>) =>
          typeof h.command === "string" &&
          h.command.includes(PKG_NAME) &&
          h.command.includes("hook-prompt"),
      );
    });

    if (!alreadyInstalled) {
      matchers.push({
        matcher: "",
        hooks: [
          {
            type: "command",
            command: HOOK_COMMAND,
          },
        ],
      });

      writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
      console.log(
        green("  ✓ Cost hook installed"),
        dim("(UserPromptSubmit, rate-limited, fires when session > $1)"),
      );
      hookInstalled = true;
    } else {
      console.log(
        green("  ✓ Cost hook"),
        dim("(already installed)"),
      );
      hookInstalled = true;
    }
  } catch (err) {
    console.log(yellow("  ⚠ Cost hook installation failed."));
    console.log(dim(`    Error: ${redactedMessage(err)}`));
    console.log();
    console.log("  Add manually to ~/.claude/settings.json:");
    console.log(
      dim(
        `    { "hooks": { "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "${HOOK_COMMAND}" }] }] } }`,
      ),
    );
  }

  console.log();
}

// ── 4. Summary ──────────────────────────────────────────────────────

console.log(dim("  ────────────────────────────────────"));

if (installed.length > 0) {
  console.log(
    `  Skills installed: ${bold(String(installed.length))}/${SKILL_NAMES.length}`,
  );
}
if (mcpRegistered) {
  console.log(`  MCP server:       ${green("registered")}`);
}
if (hookInstalled) {
  console.log(`  Cost hook:        ${green("active")}`);
}

console.log();
console.log(bold("  Restart Claude Code to activate."));
console.log();

# @compute-finance/mcp

[![npm version](https://img.shields.io/npm/v/@compute-finance/mcp.svg)](https://www.npmjs.com/package/@compute-finance/mcp)
[![npm downloads](https://img.shields.io/npm/dm/@compute-finance/mcp.svg)](https://www.npmjs.com/package/@compute-finance/mcp)
[![license](https://img.shields.io/npm/l/@compute-finance/mcp.svg)](https://github.com/compute-finance/mcp/blob/main/LICENSE)

Live AI compute pricing oracle — real-time LLM model prices across providers (Anthropic, OpenAI, Google, xAI) via the [Compute Finance Oracle](https://compute.finance).

A stdio [MCP](https://modelcontextprotocol.io) server. Works in any MCP client. Includes optional Claude Code skills for session cost analysis.

## Quick start

### Claude Code (recommended)

```bash
npx @compute-finance/mcp setup
```

This single command:
1. Registers the MCP server at user scope (`claude mcp add`)
2. Installs Claude Code skills (`/cf-session-management`, `/cf-session-consumption`, `/cf-active-sessions`)
3. Installs the **cost hook** — a `UserPromptSubmit` hook that injects session cost into Claude's context so every response can show how much you've spent

Restart Claude Code after setup.

### Any MCP client

Register the server in your client config:

```json
{
  "command": "npx",
  "args": ["@compute-finance/mcp"]
}
```

Or with a direct path:

```json
{
  "command": "node",
  "args": ["node_modules/@compute-finance/mcp/dist/index.js"]
}
```

### From source

```bash
git clone https://github.com/compute-finance/mcp.git
cd mcp
npm install && npm run build
npx . setup
```

## Tools

14 tools across four layers — no API key required:

| Layer | Tools | Purpose |
|-------|-------|---------|
| **Data** | `data_get_basket`, `data_get_price`, `data_get_scu`, `data_get_cpi`, `data_get_tiers`, `data_get_reconstitutions` | Live oracle queries |
| **Compute** | `compute_estimate`, `compute_compare` | Derived cost calculations |
| **Render** | `render_session_report`, `render_consumption_report`, `render_active_sessions` | Pre-formatted output for skills |
| **Analysis** | `analyze_session`, `analyze_turns` | Raw JSON for custom UI |
| **History** | `telemetry_get_history` | Local aggregated stats |

## Cost hook

The `setup` command installs a `UserPromptSubmit` hook into `~/.claude/settings.json`. Every time you send a message, the hook reads the current session transcript, prices it against the live oracle, and injects a cost summary into Claude's context via `additionalContext`. Claude then appends a `💰 Compute.Finance · …` line at the end of its response.

**Guards** — the hook fires only when all three conditions are met:
- Session cost exceeds **$1**
- Session has at least **5 turns**
- At least **10 minutes** since the last fire (per session)

On any failure (oracle down, transcript missing, parse error) the hook exits silently — it never blocks your prompt.

### Manual installation

If `setup` can't write to `settings.json`, add the hook manually:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "npx @compute-finance/mcp hook-prompt"
          }
        ]
      }
    ]
  }
}
```

### Uninstall

Remove the `UserPromptSubmit` entry from `~/.claude/settings.json`.

## Privacy

All data stays on your machine. The only network calls are unauthenticated GETs to `api.compute.finance/v1/oracle/*`. Session logs (`sessions.jsonl`, `turns.jsonl`) are never uploaded.

## Links

- [Documentation](https://github.com/compute-finance/mcp#readme)
- [Compute Finance](https://compute.finance)
- [Oracle API](https://api.compute.finance)

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

Or register manually without skills/hook:

```bash
claude mcp add --scope user compute-finance -- npx @compute-finance/mcp
```

### Cursor / VS Code / Any MCP client

Add to your MCP config (`.cursor/mcp.json`, VS Code settings, etc.):

```json
{
  "mcpServers": {
    "compute-finance": {
      "command": "npx",
      "args": ["@compute-finance/mcp"]
    }
  }
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

14 tools across five layers — no API key required. All tools are read-only.

### Data (live oracle)

| Tool | Description |
|------|-------------|
| `data_get_basket` | All models with provider, tier, USD prices per million tokens, cache multipliers |
| `data_get_price` | Price for a single model (e.g. `claude-opus-4.7`) |
| `data_get_scu` | Current Standard Compute Unit — the market benchmark price |
| `data_get_cpi` | Full Compute Price Index — basket with SCU breakdown, version, raw/marked-up prices |
| `data_get_tiers` | Tier weights (frontier, standard, lightweight) and per-tier averages |
| `data_get_reconstitutions` | Historical basket changes — model swaps, SCU before/after |

### Compute

| Tool | Description |
|------|-------------|
| `compute_estimate` | Nominal USD cost for a model given input/output token counts |
| `compute_compare` | Rank all basket models by cost for a workload, grouped by tier |

### Render (Claude Code skills)

| Tool | Description |
|------|-------------|
| `render_session_report` | Pre-formatted session cost report — used by `/cf-session-management` |
| `render_consumption_report` | Pre-formatted per-inference breakdown — used by `/cf-session-consumption` |
| `render_active_sessions` | Overview of recent sessions across projects — used by `/cf-active-sessions` |

Reports surface three orthogonal counts: **prompts** (what you typed), **inferences** (assistant replies — tool-loop sessions produce several per prompt), and **tool calls** (`tool_use` blocks). The triplet is identical across all three reports for the same session.

### Analysis

| Tool | Description |
|------|-------------|
| `analyze_session` | Raw JSON session analysis (for custom UI, not skills) |
| `analyze_inferences` | Raw JSON per-inference breakdown (for custom UI, not skills) |

### History

| Tool | Description |
|------|-------------|
| `telemetry_get_history` | Aggregate stats across logged sessions — cumulative cost, per-profile medians, insights |

## Cost hook

The `setup` command installs a `UserPromptSubmit` hook into `~/.claude/settings.json`. Every time you send a message, the hook reads the current session transcript, prices it against the live oracle, and injects a cost summary into Claude's context via `additionalContext`. Claude then appends a `💰 Compute.Finance · …` line at the end of its response.

**Guards** — the hook fires only when all three conditions are met:
- Session cost exceeds **$1**
- Session has at least **5 user prompts**
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

All data stays on your machine. The only network calls are unauthenticated GETs to `api.compute.finance/v1/oracle/*`. Session logs (`~/.compute-finance/sessions.jsonl`, `~/.compute-finance/inferences.jsonl`) are never uploaded.

## Links

- [Compute Finance](https://compute.finance)
- [Oracle API](https://api.compute.finance)
- [OpenAPI spec](https://api.compute.finance/v1/openapi.yaml)
- [npm package](https://www.npmjs.com/package/@compute-finance/mcp)

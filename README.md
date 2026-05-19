# Compute Finance Oracle MCP

## What is this?

[Compute Finance](https://compute.finance) is a live AI compute pricing oracle that tracks real-time prices for LLM models across providers (Anthropic, OpenAI, Google, xAI). This MCP server lets any AI agent or IDE query the oracle to get per-session cost breakdowns with provider-specific cache math — no API key required.

A stdio MCP server that prices real LLM sessions against the live Compute Finance Oracle, with provider-specific cache math. Works in any MCP client. Includes optional Claude Code skills that read transcripts directly.

### Key terms

| Term | Definition |
|------|-----------|
| **SCU** | Standard Compute Unit — a market benchmark price for AI compute, calculated from a weighted basket of models across three tiers. |
| **$COMPUTE** | The protocol's ERC-20 token on Base L2, used as the unit of account for AI compute pricing. |
| **Basket** | The set of models currently tracked by the oracle, grouped into frontier / standard / lightweight tiers. |
| **CT** | Compute Token — internal unit for per-million token pricing (equivalent to $COMPUTE). |
| **Reconstitution** | A change to the basket composition (model added, removed, or re-tiered). |

## Vision — your Session Model Manager (SMM)

The Compute Finance MCP is the foundation for a **Session Model Manager** — a personal layer that turns every LLM session into measured data and, over time, teaches you when a cheaper model would have done the same job.

**How it works, in one line:** we calculate effective cost with cache math, analyze the session shape from real signals, and recommend only from patterns in your own history — never from generic benchmarks.

- **Calculate** — live oracle prices × real transcript tokens × provider-specific cache math
- **Analyze** — session profile from observed tool-call shape + thinking signals + counterfactual across basket
- **Recommend** — after ≥5 sessions, surface pattern insights grounded in your data alone

The Oracle is the trust anchor (live, transparent benchmark). Skills are where measurement becomes personal intelligence.

## Skills

All three skills are **code-driven**: SKILL.md is ~5 lines. The MCP returns a pre-formatted `text` string; the skill prints it verbatim. Output is byte-identical across models/hosts, burns ~0 orchestration tokens, and works on any hardware.

| Skill | Purpose | Tool |
|---|---|---|
| **`cf-session-management`** | Post-session cost + counterfactual across basket + history-grounded insights after n≥5 sessions. | `render_session_report` |
| **`cf-session-consumption`** | Per-turn token spend breakdown with visual bar chart, tool aggregates, mechanical facts. | `render_consumption_report` |
| **`cf-active-sessions`** | Multi-session overview across all Claude Code projects — useful when running several panes in parallel. | `render_active_sessions` |

The installer prompts which skill(s) you want. More `cf-*` skills will land here (budget awareness, pre-flight routing, subscription-mode).

## Provider neutrality

The basket and prices are **live data**, not code:

- `/v1/oracle/basket` is the canonical basket — the MCP reads it on every call (60s in-memory cache). Newly-listed models, new providers, and post-reconstitution changes appear automatically; no release needed to keep the MCP in sync with the on-chain basket.
- `/v1/oracle/pricing` is queried in parallel only for an optional per-model `cache` block. If the oracle publishes one, the MCP uses it directly. If not, it falls back to provider-level defaults in `CACHE_FALLBACKS_BY_PROVIDER` (`mcp/src/oracle/types.ts`) — adding a new provider = one data row.
- `effectiveCost` has no `if (provider === "anthropic")` branches — multipliers are always `price.cache.{read,write_5m,write_1h}`. The `cache.source` field reports `"oracle" | "oracle-partial" | "local-fallback"` so consumers know the provenance.
- Model resolution (`claude-opus-4-7` → `claude-opus-4.7`) is **algorithmic** in `canonicalizeIn()` — strips date suffixes / bracket metadata, then walks every digit-hyphen-digit boundary as a candidate dot replacement against the live basket. No alias table, no per-model data.
- Insight generation (`frontier_underused`) computes cost ratios on the fly from live basket prices — no hardcoded model names or constants.

## Roadmap notes

- ✅ **Code-driven skills** — done. `render_*` tools return formatted text; skills are 2-line wrappers.
- ✅ **Live basket from oracle** — done. CPI sourced live; hardcoded model list removed.
- **Subscription-mode for $20 users.** Translate dollar cost into "you used X% of today's likely message budget." Different lens, same data. Biggest user-base unlock.
- **Oracle-published cache multipliers.** Feature request filed; when the oracle ships them, the local provider-keyed defaults become dead code we can delete.

## MCP tools

14 tools across four layers:

- **Data (live oracle)** — `data_get_basket`, `data_get_price`, `data_get_scu`, `data_get_cpi`, `data_get_tiers`, `data_get_reconstitutions`
- **Compute (nominal)** — `compute_estimate`, `compute_compare`
- **Render (code-driven, skill-facing)** — `render_session_report`, `render_consumption_report`, `render_active_sessions`
- **Raw analysis (for non-Claude-Code clients building custom UI)** — `analyze_session`, `analyze_turns`
- **History (local)** — `telemetry_get_history`

Every number traces to either the oracle API or a real transcript. No estimation, no projection, no invented fields.

### Naming convention

Tool names use a layered prefix scheme.

| Layer | Prefix | Purpose |
|-------|--------|---------|
| Data | `data_get_*` | Live oracle queries |
| Compute | `compute_*` | Derived calculations |
| Render | `render_*` | Pre-formatted output for skills |
| Analysis | `analyze_*` | Raw JSON for custom UI |
| History | `telemetry_get_*` | Local aggregated stats |

## Install

### With Claude Code

```bash
git clone https://github.com/compute-finance/compute-finance-mcp.git
cd compute-finance-mcp
./install.sh          # macOS / Linux / Git Bash
```

On Windows PowerShell:
```powershell
git clone https://github.com/compute-finance/compute-finance-mcp.git
cd compute-finance-mcp
.\install.ps1
# if execution policy blocks it:
# powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Requires Node ≥20 and Claude Code. The installer registers the MCP at user scope and prompts which skill(s) to install. Restart Claude Code after install.

### With any other MCP client

```bash
git clone https://github.com/compute-finance/compute-finance-mcp.git
cd compute-finance-mcp/mcp
npm install && npm run build
```

Then register the server in your client:

```
command: node
args:    ["/absolute/path/to/compute-finance-mcp/mcp/dist/index.js"]
```

`analyze_session` and `analyze_turns` currently read Claude Code's transcript format. Adapting to other clients means adding a parser in `mcp/src/storage/`.

## Structure

```
compute-finance-mcp/
├── mcp/                       # MCP server (TypeScript, stdio)
│   ├── src/
│   │   ├── index.ts           # tool definitions + handlers
│   │   ├── oracle/            # oracle client, cache math
│   │   └── storage/           # transcript parsers (session, turns), local history
│   └── package.json
├── skills/
│   ├── cf-session-management/
│   ├── cf-session-consumption/
│   └── cf-active-sessions/
├── docs/
│   └── ORACLE_FEATURE_REQUEST_cache_multipliers.md
├── install.sh
└── README.md
```

## Use

**In Claude Code:** invoke `/cf-session-management` at the end of a session for cost + history insights. Invoke `/cf-session-consumption` to see where tokens went per turn. Invoke `/cf-active-sessions` to see consumption across every pane you have open. Each appends to its own local log (`sessions.jsonl`, `turns.jsonl`).

**In any MCP client:** call `render_*` for formatted text (byte-identical across models), or `analyze_session` / `analyze_turns` for raw JSON to build your own UI.

## Privacy

All data stays on your machine. Session transcripts are already local to Claude Code. The only network calls are `GET api.compute.finance/v1/oracle/{basket,pricing,scu,tiers,reconstitutions}` (public, no auth). Your `sessions.jsonl` and `turns.jsonl` are never uploaded.

## Basket

The MCP tracks whatever models the Compute Finance Oracle currently lists in `/v1/oracle/basket` -- Anthropic, OpenAI, Google, and xAI across three tiers (frontier / standard / lightweight). New models appear automatically when the oracle adds them; retired models drop out after each on-chain reconstitution. To see the current basket: call `data_get_basket` or `data_get_cpi`.

Override the API base for testing with `CF_API_BASE=https://staging-api.compute.finance`.

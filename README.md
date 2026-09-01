# @compute-finance/mcp

[![npm version](https://img.shields.io/npm/v/@compute-finance/mcp.svg)](https://www.npmjs.com/package/@compute-finance/mcp)
[![npm downloads](https://img.shields.io/npm/dm/@compute-finance/mcp.svg)](https://www.npmjs.com/package/@compute-finance/mcp)
[![license](https://img.shields.io/npm/l/@compute-finance/mcp.svg)](https://github.com/compute-finance/mcp/blob/main/LICENSE)

Live AI compute pricing oracle — real-time LLM model prices across nine vendors (Anthropic, OpenAI, Google, DeepSeek, xAI and four more) via the [Compute Finance Oracle](https://compute.finance).

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

21 tools across five layers — no API key required. All tools are read-only.

### Data (live oracle)

| Tool | Description |
|------|-------------|
| `data_get_basket` | Every model in the current SCU index, with provider, family (e.g. `openai.gpt`, `anthropic.claude`), `base_*` and `billed_*` USD prices per million tokens, per-component cache pricing (read, write-5m, write-1h), a reasoning output price and the long-context price ladder |
| `data_get_price` | Price for a single model (e.g. `anthropic/claude-opus-4.8`) — index members and catalog-only entries on identical terms, with the same per-component cache and reasoning prices and the long-context price ladder |
| `data_get_scu` | Current Standard Compute Unit — value plus a methodology-versioned `breakdown` listing every family representative |
| `data_get_breakdown` | Per-family blended-cost breakdown alone — methodology-versioned discriminated union with one entry per family representative |
| `data_get_cpi` | Full Compute Price Index as last attested on-chain — `scuUsd`, `revisionVersion`, the raw and marked-up prices that revision published |
| `data_get_reconstitutions` | Historical index changes — model swaps, SCU before/after |
| `data_get_methodology` | Methodology changelog — every version with its formula summary and spec link, plus the version in force |
| `data_get_history` | SCU index time series over a date range — `per-revision`, `daily`, or `weekly` granularity; daily/weekly buckets carry the last revision's value forward across empty buckets |
| `data_get_model_price_history` | Per-model input/output USD price time series for any oracle-tracked model — same granularity semantics as `data_get_history`, with catchup gaps surfaced in `unavailableRevisions` |
| `data_get_catalog` | Every model with a recorded price, index members and non-index entries alike — `indexMember` flag, current price with its provenance pair, cache and reasoning components, and the raw upstream `contextTiers` / `maxInputTokens` |
| `data_get_model_price_at` | Per-model input/output USD price effective at a timestamp — `manifest` source when the model represented its family in the revision active then, `catalog` otherwise |
| `data_get_baseline` | Frozen SCU denominator behind `computeIndex` — the SCU of the first confirmed revision, set once and never recomputed |
| `data_get_scu_at` | SCU value active at a timestamp via step function — no interpolation, `null` before the genesis revision |

Models are identified by their canonical vendor-prefixed id — `anthropic/claude-opus-4.8`, `openai/gpt-5.5`, `qwen/qwen-3.5-flash`. Every tool taking a model also accepts the bare name (`gpt-5.5`) and answers with the canonical id. The vendor slug is not always the provider key (`alibaba` → `qwen`, `xai` → `x-ai`, `moonshot` → `moonshotai`), so reuse an id the API returned rather than assembling one. `data_get_scu`, `data_get_breakdown` and `data_get_reconstitutions` are the exception: they pass the attested manifest through verbatim and so report bare model keys, because a `/` is not a legal manifest key.

Cache pricing comes from the Compute Finance Oracle. Session and consumption reports show effective (cache-aware) cost when the oracle has published the relevant cache components; otherwise they show nominal cost (input rate applied to every input variant) and label effective as unavailable for that model.

Alongside cache, the oracle publishes a **reasoning output price** — `reasoning.reasoningOutput`, on the same base as every other component; the whole `reasoning` block is `null` for a model with no usable reasoning price. It is catalogue data. Session and consumption reports do not bill it: Claude Code transcripts count thinking blocks rather than reasoning tokens, and those tokens are already inside `output_tokens`.

Every price is reported on two bases: `base_*` is the provider list price, identical for every model the oracle tracks, and `billed_*` is what compute.finance charges — `base × (1 + routing_fee_rate)`. Compare models on `base_*`, budget on `billed_*`. The rate ships once per response and `billed_*` is null when the oracle does not publish it. Session and consumption reports are on the base basis throughout.

Every current-price answer comes from one place: the live catalogue the exchange bills against. Index membership decides which models `data_get_basket` and `compute_compare` list, never what a model costs, so two models the catalogue prices alike quote alike. `data_get_cpi` is the exception by design — it serves the prices the latest on-chain revision attested, which change only when an operator publishes the next one and may therefore lag the catalogue. Read it as attestation history, not as a quote.

Some models get pricier past a context length. `data_get_basket` and `data_get_price` publish that as `context_tiers`, a ladder ascending by `from_input_tokens` and **always at least one rung**: the first starts at 0 and restates the flat rate, so a model priced the same at every size has exactly one rung and nothing has to branch on whether a model happens to be tiered. Rungs carry `base_*` and `billed_*` like every other price; only the flat rate enters the SCU index. `compute_estimate` and `compute_compare` pick the rung from the whole input side of the request — prompt plus cache reads plus cache writes, all charged at the full input rate there since neither tool applies a cache discount — over half-open ranges, so an input landing exactly on a threshold takes that rung, and both return the chosen rung as `applied_context_tier` so the rate behind the number is visible. `data_get_catalog` passes the oracle document through unchanged, so there `contextTiers` is absent rather than one-rung on a flat model.

The ladder comes from the catalog endpoint, and the two kinds of tool part ways whenever it cannot answer for a model — the read failed, or it succeeded and the model was not in it, which is upstream drift rather than a flat price. `data_get_basket` and `data_get_price` still serve their prices and set `context_tiers` to `null` — an unknown ladder, never a one-rung stand-in for a ladder nobody read. `compute_estimate` and `compute_compare` error instead: a cost quoted at the flat rate would understate exactly the long context the ladder exists to price.

`max_input_tokens` is the largest input a model accepts, `null` when the model declares no window of its own — not unbounded: the request-body ceiling still applies, there is just no per-model limit. Above a declared window the oracle refuses the request outright, so `compute_estimate` and `compute_compare` set `exceeds_max_input_tokens`. They still quote the cost: these tools are read-only and an agent sizing a context needs the number before it reshapes the request, but the flag says plainly that the request as supplied would be rejected.

Prices also carry a `provenance` mark saying how far the number has been checked: `verified` — an operator recorded a vendor source for it; `inferred` — derived from a sibling number or a vendor default, with no source recorded; `promotional` — a discounted list price that is expected to end. **Every value bills as shown; the mark says how much to trust it, not what it costs.** Marks are set by hand and hold as of the operator's last pass, not as a live check against the vendor. Every cache and reasoning component carries its own mark wherever it appears, and so does every base price: `data_get_catalog` marks `currentPrice.provenance` for every model, index member or not, while `data_get_basket`, `data_get_price` and `compute_estimate` carry the same pair as `base_price_provenance`. A rung follows the same rule: the first repeats the base price's mark, and a higher rung is always a catalogue number, marked in both directions with the single mark the vendor quotes it under. Session and consumption reports print each cache multiplier with its mark; when the oracle publishes no cache pricing for a model they say so and print no marks.

### Compute

| Tool | Description |
|------|-------------|
| `compute_estimate` | Nominal USD cost for a model given input/output token counts — `base_usd_cost`, `routing_fee_usd`, `billed_usd_cost`, quoted at the rung the input size selects |
| `compute_compare` | Rank every model in the current SCU index by cost for a workload, grouped by family — the same three cost figures per row, each on that model's own rung |

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

The `analyze_session` counterfactual quotes each model's base rate and never a long-context rung. A rung is picked per request, and a session's summed input is not one giant request — a hundred 5k-token calls are not a single 500k-token one — so pricing the total on a higher rung would overcharge. Expect those rows to sit below `compute_compare` for a model that gets pricier past a context length.

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

All data stays on your machine. The only network calls are unauthenticated GETs to `api.compute.finance` — the oracle endpoints under `/v1/oracle/*` and the OpenAPI document at `/openapi.json`, read once at startup to document oracle response shapes. Session logs (`~/.compute-finance/sessions.jsonl`, `~/.compute-finance/inferences.jsonl`) are never uploaded.

## Links

- [Compute Finance](https://compute.finance)
- [Oracle API](https://api.compute.finance)
- [OpenAPI spec](https://api.compute.finance/openapi.json)
- [npm package](https://www.npmjs.com/package/@compute-finance/mcp)

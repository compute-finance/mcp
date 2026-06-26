---
name: cf-session-consumption
description: Per-inference token spend breakdown of the current Claude Code session (one row per assistant reply). Fully code-driven — the MCP returns a pre-formatted visual report; the skill only prints it. Invoke when the user wants to understand the shape of their session's consumption.
---

# cf-session-consumption

1. Call `render_consumption_report` with no arguments (or `{ "full": true }` if the user explicitly asks for every inference).
2. Print the `text` field **verbatim, inside a fenced code block** (```), so its monospace bar chart and column alignment are preserved. Do not reformat, reinterpret, add analysis, or make other tool calls.

If the user asks "what does this mean" or "why", respond: `"This skill is descriptive only. Run /cf-session-management for history-grounded insights once you have ≥5 sessions logged."` Do not interpret inline. The separation is load-bearing: consumption shows where tokens went; management interprets across history.

For multi-session overview ("what did I spend across all my panes today?"), use `render_active_sessions` instead.

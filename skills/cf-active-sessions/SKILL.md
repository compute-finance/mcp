---
name: cf-active-sessions
description: One-shot overview of recent Claude Code sessions across all projects — per-session token totals and effective/nominal cost. Fully code-driven. Invoke when the user has multiple Claude Code panes/sessions running and wants to see consumption across them.
---

# cf-active-sessions

1. Call `render_active_sessions` with no arguments (defaults to last 24h, top 10 by recency, across all projects). Supported optional args: `cwd`, `limit`, `hours`.
2. Print the `text` field **verbatim**.

No interpretation, no reformatting.

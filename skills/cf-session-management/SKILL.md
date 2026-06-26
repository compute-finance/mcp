---
name: cf-session-management
description: Measured post-session cost analysis using live Compute Finance Oracle prices and the real transcript. Fully code-driven — the MCP returns a pre-formatted report; the skill only prints it. Invoke when the user wants a post-mortem or cost check.
---

# cf-session-management

1. Call `render_session_report` with no arguments.
2. Print the `text` field **verbatim, inside a fenced code block** (```), so its monospace column alignment is preserved. Do not reformat, summarise, interpret, add commentary, or make any additional tool calls.

That is the entire skill. All measurement, pricing, history logging, and insight generation happen inside the MCP. If the user asks follow-ups, you may answer using only the printed text plus `data_get_price` / `compute_compare` if they ask "what if".

---
name: cf-account
description: Answer questions about the user's own Compute Finance account — balance, spend, API keys, spending caps — through the account_* MCP tools. Invoke when the user asks what they spent, which of their keys are live, or how much headroom is left before a cap.
---

# cf-account

1. Answer only from an `account_*` tool. The registered list is authoritative — read each tool's own description and input schema rather than assuming a name; call `account_overview` first when you do not yet know which account the grant is pinned to.
2. Report every figure exactly as returned. Never compute or convert a balance, a spend total, remaining headroom or a permission yourself, and never fill in a figure the answer marks unavailable.
3. A refusal is an answer. Repeat the message the tool returned — it names the access that is missing. Never restate it as an empty balance, an empty key list or nothing spent, and never retry the same call.
4. If no `account_*` tool is registered, no account is connected: say so and point at `npx @compute-finance/mcp setup --account`.

Oracle prices (`data_get_price`, `compute_estimate`) and local session reports (`render_session_report`, `analyze_session`) answer different questions from different sources — never blend them into an account answer.

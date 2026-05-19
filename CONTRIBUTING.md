# Contributing to Compute Finance MCP

Thanks for your interest in contributing! This document covers the basics.

## Development setup

```bash
git clone https://github.com/compute-finance/compute-finance-mcp.git
cd compute-finance-mcp/mcp
npm install
npm run build
```

Node >= 20 is required.

## Making changes

1. Fork the repo and create a branch from `main`.
2. Make your changes in `mcp/src/`.
3. Run `npm run build` in `mcp/` to verify the TypeScript compiles.
4. Run `npm test` if tests exist for the area you changed.
5. Open a pull request against `main`.

## Code style

- TypeScript strict mode.
- No `any` casts unless unavoidable (document why).
- All error responses must use the `errorText()` helper so `isError: true` is set.
- API endpoint paths must match the live Oracle API at `api.compute.finance`.

## Tool naming

Tools follow a layered naming convention:

| Layer | Prefix | Examples |
|-------|--------|---------|
| Data (live oracle) | `data_get_*` | `data_get_basket`, `data_get_price` |
| Compute | `compute_*` | `compute_estimate`, `compute_compare` |
| Render (skill-facing) | `render_*` | `render_session_report` |
| Raw analysis | `analyze_*` | `analyze_session`, `analyze_turns` |
| History | `telemetry_get_*` | `telemetry_get_history` |

All tools follow the `<layer>_<verb>` convention.

## Reporting issues

Use GitHub Issues. For security vulnerabilities, see `SECURITY.md`.

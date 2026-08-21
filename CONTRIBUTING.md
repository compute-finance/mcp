# Contributing to Compute Finance MCP

Thanks for your interest in contributing! This document covers the basics.

## Development setup

```bash
git clone https://github.com/compute-finance/mcp.git
cd mcp
npm install
npm run build
```

Node >= 20 is required.

## Making changes

1. Fork the repo and create a branch from `main`.
2. Make your changes in `src/`.
3. Run `npm run build` to verify the TypeScript compiles.
4. Run `npm test` if tests exist for the area you changed.
5. Open a pull request against `main`.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) — they drive the automated release pipeline ([release-please](https://github.com/googleapis/release-please)). The PR title becomes the squash-merge commit message, so it must follow the convention.

| Prefix | Meaning | Effect on version |
|--------|---------|-------------------|
| `feat:` | New user-facing capability | minor bump |
| `fix:` | Bug fix | patch bump |
| `perf:` | Performance improvement | patch bump |
| `docs:` | Documentation only | no bump (appears in changelog) |
| `test:` | Test changes only | no bump (appears in changelog) |
| `refactor:` | Internal restructuring, no behavior change | no bump (appears in changelog) |
| `build:` | Build system / dependencies | no bump (appears in changelog) |
| `ci:` | CI configuration | no bump (hidden from changelog) |
| `chore:` | Other maintenance | no bump (hidden from changelog) |

Breaking changes: append `!` after the type (`feat!: …`) or include a `BREAKING CHANGE:` footer. While the package is pre-1.0, breaking changes bump the **minor** version, not major.

Examples:
- `fix: handle empty basket response from oracle`
- `feat: add render_session_report tool`
- `docs: clarify cost hook guards in README`

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
| Raw analysis | `analyze_*` | `analyze_session`, `analyze_inferences` |
| History | `telemetry_get_*` | `telemetry_get_history` |

All tools follow the `<layer>_<verb>` convention.

## Releasing

Releases are automated via [release-please](https://github.com/googleapis/release-please). A "Release PR" titled `chore(main): release X.Y.Z` is kept open on `main` — it accumulates conventional commits since the last release, updates the version in `package.json` / `server.json`, and rewrites `CHANGELOG.md`.

To cut a release: review the changelog in the open Release PR and merge it. Merging triggers tag creation, `npm publish` (with provenance), and publication to the MCP Registry — all in the same workflow.

Requires repo setting Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" to be ON, otherwise the Release PR cannot be opened.

If the publish job fails after the release was tagged, re-run the failed job from the Actions tab — `npm publish` and `mcp-publisher publish` are idempotent against tag re-runs.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).

## Reporting issues

Use GitHub Issues. For security vulnerabilities, see `SECURITY.md`.

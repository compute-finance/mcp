# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in this project, please report it
responsibly. **Do not open a public GitHub issue.**

Email: **security@compute.finance**

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to provide a fix or
mitigation plan within 7 days.

## Scope

This MCP server calls the public Compute Finance Oracle API without
authentication, reads local Claude Code transcripts, and — once a user connects
an account — calls the account endpoints with an **app grant** token. It never
handles private keys or wallet signatures, and no grant can take money out of an
account. Security concerns most likely to apply:

- **Grant token handling** (`src/account/`): the token must never reach stdout,
  stderr, a tool answer, a log, a config file, a process argument, or the
  environment of a child process; diagnostics are redacted before they are written.
- **OS credential stores** (`src/account/os-store.ts`): `setup --account` writes
  the token to macOS Keychain (`security`), Windows DPAPI (a blob under
  `%APPDATA%`) or the Linux Secret Service (`secret-tool`), always over the
  helper's stdin; `setup --forget-account` removes it.
- **`CF_APP_GRANT_COMMAND`** (`src/account/credential.ts`, `src/account/spawn.ts`):
  the server runs this user-supplied command through the shell at startup and
  takes the first non-empty line it prints as the token. It inherits the user's environment
  without `CF_APP_GRANT` and is stopped after a timeout.
- **API origin enforcement** (`src/account/client.ts`): the token is sent only to
  an `https` origin, or to `http` on a loopback host; a `CF_API_BASE` pointing
  anywhere else is refused and the token is not sent.
- **Act tools**: a grant with Act access lets an agent create an API key that
  spends the account's balance, freeze or unfreeze keys, change budget caps and
  configure auto top-up. The exchange decides what each grant may call; this
  package must pass refusals through unchanged and never widen what a grant allows.
- Dependency vulnerabilities (supply chain).
- Unexpected data exposure via MCP tool responses.
- Local file access issues in transcript parsing and session logs (`src/storage/`).

## Supported versions

Only the latest release on `main` receives security updates.

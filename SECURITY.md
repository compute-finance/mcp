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

This MCP server is a read-only client that calls the public Compute Finance
Oracle API. It does not handle authentication, private keys, or financial
transactions. Security concerns most likely to apply:

- Dependency vulnerabilities (supply chain)
- Unexpected data exposure via MCP tool responses
- Local file access issues in transcript parsing (`mcp/src/storage/`)

## Supported versions

Only the latest release on `main` receives security updates.

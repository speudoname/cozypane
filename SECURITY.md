# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in CozyPane, please report it responsibly.

**Do not open a public issue for security vulnerabilities.**

The preferred channel is a private GitHub Security Advisory:

https://github.com/speudoname/cozypane/security/advisories/new

GitHub advisories go straight to the maintainers and support private
back-and-forth discussion, CVE assignment, and coordinated disclosure. If
you cannot use GitHub, contact the maintainer (Levan) at the email listed
on the GitHub profile for `speudoname`.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response

We will acknowledge your report within 48 hours and work to release a fix as quickly as possible.

## Scope

CozyPane consists of:

1. **Desktop Electron app** (`cozypane/`) — runs locally on user machines.
2. **Cloud PaaS backend** (`cozypane-cloud/`) — Fastify + Docker + Postgres,
   deployed at `api.cozypane.com`.

Relevant security concerns include:

**Desktop:**
- Arbitrary code execution via IPC handlers
- File system access beyond intended scope (the allowlist fence in
  `src/main/filesystem.ts`)
- Credential handling (tokens encrypted via Electron safeStorage; writes
  refuse to fall back to base64 unless the user sets
  `COZYPANE_ALLOW_UNENCRYPTED_CREDENTIALS=1`)
- Webview attach hardening (`will-attach-webview` in `main.ts`)
- Git remote URL validation (`ext::` / `file://` transport allowlist)

**Cloud:**
- Tenant isolation across deployments (all queries scope by `user_id`)
- Custom-domain verification (CNAME / A-record only — HTTP-response
  fallback removed to prevent squatting)
- Admin JWT transport (HttpOnly cookie, not URL fragment)
- GitHub tokens encrypted at rest in `users.access_token` (AES-256-GCM)
- Docker API access (per-user networks, cap-drop ALL + no-new-privileges)
- Traefik dashboard (not exposed publicly — do NOT enable
  `--api.insecure` on any deploy)

## Supported Versions

Only the latest minor release receives security fixes.

| Version | Supported |
|---------|-----------|
| 0.7.x   | Yes       |
| < 0.7   | No        |

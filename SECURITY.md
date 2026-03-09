# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in CozyPane, please report it responsibly.

**Do not open a public issue for security vulnerabilities.**

Instead, please email **security@cozypane.com** or open a private security advisory on GitHub:

https://github.com/speudoname/cozypane/security/advisories/new

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response

We will acknowledge your report within 48 hours and work to release a fix as quickly as possible.

## Scope

CozyPane is a desktop Electron application. Security concerns include:

- Arbitrary code execution via IPC handlers
- File system access beyond intended scope
- Credential handling (API keys stored via Electron safeStorage)
- Dependency vulnerabilities

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

let log: FastifyBaseLogger = console as any;

export function setTraefikLogger(logger: FastifyBaseLogger): void {
  log = logger;
}

// Traefik file-provider helpers, split out of routes/deploy.ts (audit H18).
// Traefik watches the `TRAEFIK_DYNAMIC_DIR` volume and auto-reloads when
// these files change — no container restart needed.

const TRAEFIK_DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR || '/traefik-dynamic';

export function customDomainConfigPath(domain: string): string {
  const safe = domain.replace(/[^a-z0-9.-]/g, '-');
  return join(TRAEFIK_DYNAMIC_DIR, `custom-${safe}.yml`);
}

export function writeCustomDomainConfig(subdomain: string, domain: string, _port: number): void {
  // Defense-in-depth: reject domains with characters that could break Traefik
  // YAML/Go-template syntax. Upstream isValidDomainName regex should already
  // block these, but the YAML writer must not rely on upstream validation.
  if (/[`"'\n\r\\|{}]/.test(domain)) {
    throw new Error(`Domain contains unsafe characters: ${domain}`);
  }

  const routerName = `cp-${subdomain}`;
  const safeDomain = domain.replace(/\./g, '-');
  const customRouter = `cp-custom-${safeDomain}`;

  // The service is defined by Docker labels on the container (Docker provider).
  // File provider routers can reference Docker provider services via @docker suffix.
  const yaml = `http:
  routers:
    ${customRouter}:
      rule: "Host(\`${domain}\`)"
      entrypoints:
        - websecure
      tls:
        certResolver: cloudflare
      service: ${routerName}@docker
`;

  try {
    mkdirSync(TRAEFIK_DYNAMIC_DIR, { recursive: true });
    writeFileSync(customDomainConfigPath(domain), yaml);
    log.info({ domain }, 'Wrote Traefik config for custom domain');
  } catch (err: any) {
    log.warn({ domain, err: err.message }, 'Failed to write Traefik config');
  }
}

export function removeCustomDomainConfig(domain: string): void {
  try {
    const filePath = customDomainConfigPath(domain);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      log.info({ domain }, 'Removed Traefik config for custom domain');
    }
  } catch (err: any) {
    log.warn({ domain, err: err.message }, 'Failed to remove Traefik config');
  }
}

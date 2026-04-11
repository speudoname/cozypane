// Custom domain verification logic. Pre-Wave-7 this lived inline in the
// POST /deploy/:id/domains/:domainId/verify handler in routes/deploy.ts,
// mixing DNS lookups with the route handler's HTTP concerns. Extracted
// so the route stays thin and the verification policy can be unit-tested
// or swapped without touching the route layer.
//
// Security note (C2 fix from the prior audit, preserved verbatim): a
// previous revision verified domains whenever any HTTP request to the
// domain succeeded, which let attackers claim a victim's production
// domain by pointing verification at the real server. Verification now
// requires either a CNAME to our subdomain OR an A-record IP match
// against our subdomain's resolved IPs. No HTTP-based fallback exists.

import dns from 'node:dns/promises';

export interface DomainVerificationResult {
  verified: boolean;
  /** Human-readable reason for failure, null on success. */
  error: string | null;
}

/**
 * Check whether `domain` points at `expectedCname` via either a CNAME
 * record or an A-record IP match. Returns `{ verified, error }` —
 * `error` is non-null with a user-visible message when verification
 * fails in a recoverable way (DNS not propagated yet, resolved to the
 * wrong server).
 */
export async function verifyDomain(
  domain: string,
  expectedCname: string,
): Promise<DomainVerificationResult> {
  // Try CNAME first — the happy path for the majority of users.
  try {
    const cnameRecords = await dns.resolve(domain, 'CNAME');
    const match = cnameRecords.some(
      (r: string) => r.toLowerCase().replace(/\.$/, '') === expectedCname.toLowerCase(),
    );
    if (match) return { verified: true, error: null };
  } catch {
    // No CNAME — fall through to A-record comparison. Apex domains
    // (example.com) can't have real CNAMEs; providers like Cloudflare
    // flatten them to A records at resolve time.
  }

  // A-record comparison: resolve both the custom domain and our target
  // to IPs and look for an intersection.
  try {
    const [customIps, targetIps] = await Promise.all([
      dns.resolve(domain, 'A').catch(() => [] as string[]),
      dns.resolve(expectedCname, 'A').catch(() => [] as string[]),
    ]);

    if (customIps.length > 0 && targetIps.length > 0) {
      const match = customIps.some((ip: string) => targetIps.includes(ip));
      if (match) return { verified: true, error: null };
    }

    if (customIps.length === 0) {
      return {
        verified: false,
        error: 'No DNS records found. DNS changes can take a few minutes to propagate.',
      };
    }

    return {
      verified: false,
      error: 'Domain resolves but could not reach the server. Check your DNS configuration.',
    };
  } catch (err: any) {
    return {
      verified: false,
      error: `DNS lookup failed: ${err?.message || 'unknown error'}`,
    };
  }
}

// Loose but effective pattern: at least one dot, LDH-only labels, each
// label bounded by alphanumerics. Matches the same shape the pre-Wave-7
// inline regex enforced.
const DOMAIN_NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function isValidDomainName(domain: string): boolean {
  return DOMAIN_NAME_REGEX.test(domain);
}

export function buildExpectedCname(subdomain: string): string {
  return `${subdomain}.${process.env.DOMAIN || 'cozypane.com'}`;
}

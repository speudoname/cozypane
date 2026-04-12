// SECURITY: verification requires either a CNAME match or an A-record
// IP match against our subdomain. A previous revision verified whenever
// an HTTP request to the domain succeeded, which let attackers claim a
// victim's production domain by pointing verification at the real
// server. Do NOT add an HTTP-based fallback without a challenge token.

import dns from 'node:dns/promises';
import { DOMAIN as BASE_DOMAIN } from './serializers.js';

export interface DomainVerificationResult {
  verified: boolean;
  /** Human-readable reason for failure, null on success. */
  error: string | null;
}

export async function verifyDomain(
  domain: string,
  expectedCname: string,
): Promise<DomainVerificationResult> {
  // SECURITY: Only CNAME matching is used. A previous revision also checked
  // A-record IP overlap, but shared CDN IPs (e.g. Cloudflare) meant an
  // attacker could claim any domain on the same CDN. Do NOT re-add
  // A-record or HTTP-based fallbacks without a challenge token (e.g. TXT).
  try {
    const cnameRecords = await dns.resolve(domain, 'CNAME');
    const match = cnameRecords.some(
      (r: string) => r.toLowerCase().replace(/\.$/, '') === expectedCname.toLowerCase(),
    );
    if (match) return { verified: true, error: null };

    return {
      verified: false,
      error: `CNAME record found but does not match. Expected: ${expectedCname}. Set a CNAME record pointing your domain to ${expectedCname}.`,
    };
  } catch (err: any) {
    // NXDOMAIN, NODATA, or timeout — no CNAME record exists
    if (err?.code === 'ENODATA' || err?.code === 'ENOTFOUND') {
      return {
        verified: false,
        error: `No CNAME record found. Add a CNAME record for "${domain}" pointing to "${expectedCname}". DNS changes can take a few minutes to propagate.`,
      };
    }
    return {
      verified: false,
      error: `DNS lookup failed: ${err?.message || 'unknown error'}`,
    };
  }
}

const DOMAIN_NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function isValidDomainName(domain: string): boolean {
  return DOMAIN_NAME_REGEX.test(domain);
}

export function buildExpectedCname(subdomain: string): string {
  return `${subdomain}.${BASE_DOMAIN}`;
}

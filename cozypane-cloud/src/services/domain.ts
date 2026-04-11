// SECURITY: verification requires either a CNAME match or an A-record
// IP match against our subdomain. A previous revision verified whenever
// an HTTP request to the domain succeeded, which let attackers claim a
// victim's production domain by pointing verification at the real
// server. Do NOT add an HTTP-based fallback without a challenge token.

import dns from 'node:dns/promises';

const BASE_DOMAIN = process.env.DOMAIN || 'cozypane.com';

export interface DomainVerificationResult {
  verified: boolean;
  /** Human-readable reason for failure, null on success. */
  error: string | null;
}

export async function verifyDomain(
  domain: string,
  expectedCname: string,
): Promise<DomainVerificationResult> {
  try {
    const cnameRecords = await dns.resolve(domain, 'CNAME');
    const match = cnameRecords.some(
      (r: string) => r.toLowerCase().replace(/\.$/, '') === expectedCname.toLowerCase(),
    );
    if (match) return { verified: true, error: null };
  } catch {
    // Apex domains can't have real CNAMEs; providers like Cloudflare
    // flatten them to A records at resolve time. Fall through.
  }

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

const DOMAIN_NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function isValidDomainName(domain: string): boolean {
  return DOMAIN_NAME_REGEX.test(domain);
}

export function buildExpectedCname(subdomain: string): string {
  return `${subdomain}.${BASE_DOMAIN}`;
}

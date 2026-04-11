// Per-user sliding-window rate limiter. @fastify/rate-limit's per-route
// keyGenerator runs BEFORE any preHandler auth, so `req.user` is always
// undefined there and the fallback IP keying collapses users behind a
// shared NAT/Cloudflare edge into one bucket (or gives users on unique
// IPs effectively no per-user limit). This in-handler limiter runs AFTER
// auth so it can key on `request.user.id`.
//
// Wave 7 — extracted from the middle of routes/deploy.ts where it was an
// inline module-local helper. Used by /deploy, /deploy/:id/redeploy,
// /deploy/:id/domains, and /deploy/:id/domains/:domainId/verify.

const userRateLimits = new Map<string, number[]>();

export function checkUserRateLimit(
  userId: number,
  bucket: string,
  max: number,
  windowMs: number,
): boolean {
  const key = `${bucket}:${userId}`;
  const now = Date.now();
  const hits = userRateLimits.get(key) || [];
  // Drop hits outside the window
  const recent = hits.filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    userRateLimits.set(key, recent);
    return false;
  }
  recent.push(now);
  userRateLimits.set(key, recent);
  // Opportunistic cleanup — keep the Map from growing unbounded across users.
  if (userRateLimits.size > 5000) {
    for (const [k, v] of userRateLimits) {
      if (v.length === 0 || now - v[v.length - 1] > windowMs * 2) {
        userRateLimits.delete(k);
      }
    }
  }
  return true;
}

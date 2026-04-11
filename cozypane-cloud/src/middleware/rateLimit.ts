// Per-user sliding-window rate limiter. Runs AFTER auth so it can key
// on `request.user.id` — @fastify/rate-limit's plugin-level keyGenerator
// runs before preHandlers and collapses users behind a shared NAT edge
// into one bucket.
//
// NOTE: state is process-local. Horizontal scaling resets limits per pod.

const userRateLimits = new Map<string, number[]>();
// Last time the cleanup sweep ran. Without this guard, when size stays
// above the threshold for a while, every call triggers a full linear
// scan — and if every entry is still within its window, the sweep
// deletes nothing, leaving the limiter stuck at O(n) per call.
let lastCleanup = 0;

export function checkUserRateLimit(
  userId: number,
  bucket: string,
  max: number,
  windowMs: number,
): boolean {
  const key = `${bucket}:${userId}`;
  const now = Date.now();
  const hits = userRateLimits.get(key) || [];
  const recent = hits.filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    userRateLimits.set(key, recent);
    return false;
  }
  recent.push(now);
  userRateLimits.set(key, recent);

  if (userRateLimits.size > 5000 && now - lastCleanup > 30_000) {
    lastCleanup = now;
    for (const [k, v] of userRateLimits) {
      if (v.length === 0 || now - v[v.length - 1] > windowMs * 2) {
        userRateLimits.delete(k);
      }
    }
  }
  return true;
}

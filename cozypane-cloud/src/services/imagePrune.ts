import type { FastifyBaseLogger } from 'fastify';
import { docker } from './container.js';

// Periodic Docker image cleanup to keep the host disk from filling up.
// Removes dangling images (build intermediate layers no longer tagged)
// and build cache. Intentionally does NOT remove tagged cozypane/* images
// that are not currently referenced by a container — cleanup.ts on
// deployment delete handles those, and we don't want to race with a
// redeploy that's about to reuse the existing tag as a build cache source.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
let pruneInterval: ReturnType<typeof setInterval> | null = null;

export async function pruneDockerImages(log: FastifyBaseLogger): Promise<void> {
  try {
    const imageResult = await docker.pruneImages({ filters: { dangling: { true: true } } });
    const imageMB = Math.round((imageResult.SpaceReclaimed || 0) / 1024 / 1024);
    if (imageMB > 0) {
      log.info(`Docker image prune: reclaimed ${imageMB} MB from dangling images`);
    }
  } catch (err) {
    log.warn({ err }, 'Docker image prune failed');
  }

  try {
    // Build cache prune — the 1 GB+ of buildx/BuildKit cache that
    // accumulates across builds. Not exposed directly via Dockerode's
    // typed API, so we use the raw modem.
    const buildCacheResult = await new Promise<{ SpaceReclaimed?: number }>((resolve, reject) => {
      docker.modem.dial(
        { path: '/build/prune?all=false', method: 'POST', statusCodes: { 200: true } },
        (err, data) => (err ? reject(err) : resolve((data as any) || {})),
      );
    }).catch(() => ({} as { SpaceReclaimed?: number }));
    const cacheMB = Math.round((buildCacheResult.SpaceReclaimed || 0) / 1024 / 1024);
    if (cacheMB > 0) {
      log.info(`Docker build cache prune: reclaimed ${cacheMB} MB`);
    }
  } catch (err) {
    log.warn({ err }, 'Docker build cache prune failed');
  }
}

export function startPeriodicImagePrune(log: FastifyBaseLogger): void {
  if (pruneInterval) return;
  // Run once at startup after a short delay so boot isn't blocked, then
  // every 24 hours. The delay also ensures we don't race with a build
  // worker that was mid-build across a restart.
  setTimeout(() => { void pruneDockerImages(log); }, 30_000);
  pruneInterval = setInterval(() => { void pruneDockerImages(log); }, PRUNE_INTERVAL_MS);
}

export function stopPeriodicImagePrune(): void {
  if (pruneInterval) {
    clearInterval(pruneInterval);
    pruneInterval = null;
  }
}

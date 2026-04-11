import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { getBuildDataDir } from './buildDataDir.js';

// Delete stale `cozypane-deploy-*` extraction directories left over from
// previous process lifetimes. Anything older than 1 hour is either a
// successfully-finished build whose finally-clause cleanup was interrupted
// or a failed build that never ran its cleanup. Runs at startup alongside
// the DB reconcile so disk usage stays bounded on the build data volume.

const STALE_AGE_MS = 60 * 60 * 1000; // 1 hour

export function cleanupOrphanBuildDirs(log: FastifyBaseLogger): void {
  const baseDir = getBuildDataDir();
  let scanned = 0;
  let removed = 0;

  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch (err) {
    log.warn({ err, baseDir }, 'Could not scan build data dir for orphans');
    return;
  }

  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith('cozypane-deploy-')) continue;
    scanned++;
    const full = join(baseDir, name);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs < STALE_AGE_MS) continue;
      rmSync(full, { recursive: true, force: true });
      removed++;
    } catch (err) {
      log.warn({ err, full }, 'Could not remove orphan build dir');
    }
  }

  if (scanned > 0) {
    log.info(`Build-dir orphan sweep: ${removed}/${scanned} stale directories removed`);
  }
}

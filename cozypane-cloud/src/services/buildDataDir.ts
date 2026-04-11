import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Resolved on first call and cached. In production this is a Docker
// volume (`/var/cozypane/builds`) so tarball extracts survive API
// container recreates; in local dev it falls back to the OS tmpdir.
let cached: string | null = null;

export function getBuildDataDir(): string {
  if (cached) return cached;
  const dir = process.env.BUILD_DATA_DIR || join(tmpdir(), 'cozypane-builds');
  mkdirSync(dir, { recursive: true });
  cached = dir;
  return dir;
}

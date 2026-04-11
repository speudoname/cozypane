import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { Pool } = pg;

// Main application pool — sized for web traffic + background builds.
// `statement_timeout` is set per-session via the options string so a single
// runaway query can't pin a connection forever. `application_name` makes
// it easy to distinguish app connections from manual psql sessions on the
// postgres side.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  min: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'cozypane-cloud',
  // statement_timeout=30s prevents any single query from tailback the pool.
  // Long-running admin operations should use a dedicated client if needed.
  options: '-c statement_timeout=30000',
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

// Dedicated long-lived pool for platform-admin operations like
// provisionDatabase/dropDatabase. Previously `services/database.ts` created a
// fresh pg.Pool on every call and immediately `end()`ed it, paying ~50-150ms
// of TCP+TLS+auth handshake per call and bypassing back-pressure. The
// singleton is separated from `pool` so admin workloads can't starve the
// request-serving pool.
export const platformPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  min: 0,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'cozypane-cloud-platform',
  // No statement_timeout: CREATE DATABASE etc. can legitimately take a while
  // on a cold instance. Individual callers should still bound their work.
});

platformPool.on('error', (err) => {
  console.error('Unexpected platform pool error:', err);
});

export async function initDb(): Promise<void> {
  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  await pool.query(schema);
  console.log('Database schema initialized');
}

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { platformPool } from '../db/index.js';

let log: FastifyBaseLogger = console as any;

export function setDatabaseLogger(logger: FastifyBaseLogger): void {
  log = logger;
}

// Long-lived platform pool — previously this module created a fresh
// pg.Pool on every provision/drop call and immediately end()ed it, paying
// ~50-150ms of handshake per call and bypassing back-pressure. The shared
// singleton is defined in db/index.ts.

/**
 * Generate a safe database name from username and app name.
 * Format: cp_{userId}_{sanitized_appname}
 */
function dbName(userId: number, appName: string): string {
  const safe = appName.replace(/[^a-z0-9]/g, '_').slice(0, 40);
  return `cp_${userId}_${safe}`;
}

/**
 * Generate a safe database user name.
 */
function dbUser(userId: number, appName: string): string {
  const safe = appName.replace(/[^a-z0-9]/g, '_').slice(0, 40);
  return `cpu_${userId}_${safe}`;
}

export interface TenantDatabase {
  name: string;
  user: string;
  password: string;
  host: string;
  port: number;
  connectionString: string;
}

/**
 * Provision a PostgreSQL database for a tenant's deployment.
 * Creates a dedicated database and user with access only to that database.
 * Idempotent — safe to call on redeploy.
 */
export async function provisionDatabase(
  userId: number,
  appName: string,
): Promise<TenantDatabase> {
  const name = dbName(userId, appName);
  const user = dbUser(userId, appName);
  const password = randomBytes(24).toString('hex');

  // PostgreSQL host — inside Docker network, the postgres service is reachable by service name
  const host = 'postgres';
  const port = 5432;

  // Defense in depth: assert identifiers and password match the expected
  // shapes before they go anywhere near a SQL statement. `dbName`/`dbUser`
  // already return sanitized values, but this protects against any future
  // relaxation of the sanitizer.
  if (!/^[a-z0-9_]+$/.test(user) || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error('Invalid identifier derived from userId/appName');
  }
  if (!/^[a-f0-9]+$/.test(password)) {
    throw new Error('Password generator produced unexpected characters');
  }

  // Create user (or update password if exists).
  // CREATE/ALTER ROLE run as top-level statements (not inside a DO block)
  // so that the previous string-interpolation pattern is eliminated. The
  // identifier is double-quoted and the password is single-quoted — both
  // are safe because of the regex assertions above.
  const userExists = await platformPool.query(
    `SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [user],
  );

  if (userExists.rows.length > 0) {
    await platformPool.query(`ALTER ROLE "${user}" WITH PASSWORD '${password}'`);
  } else {
    await platformPool.query(`CREATE ROLE "${user}" WITH LOGIN PASSWORD '${password}'`);
  }

  // Create database if it doesn't exist
  const dbExists = await platformPool.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`,
    [name],
  );

  // CREATE/ALTER/DROP DATABASE cannot run inside functions or DO blocks — must be top-level.
  // name/user are sanitized to [a-z0-9_] so double-quoting is safe.
  if (dbExists.rows.length === 0) {
    await platformPool.query(`CREATE DATABASE "${name}" OWNER "${user}"`);
  } else {
    await platformPool.query(`ALTER DATABASE "${name}" OWNER TO "${user}"`);
  }

  // Grant permissions
  await platformPool.query(`GRANT ALL PRIVILEGES ON DATABASE "${name}" TO "${user}"`);

  const connectionString = `postgresql://${user}:${password}@${host}:${port}/${name}`;

  log.info({ dbName: name, dbUser: user }, 'Provisioned database');

  return { name, user, password, host, port, connectionString };
}

/**
 * Drop a tenant's database and user.
 * Used when deleting a deployment.
 */
export async function dropDatabase(
  userId: number,
  appName: string,
): Promise<void> {
  const name = dbName(userId, appName);
  const user = dbUser(userId, appName);

  // Terminate active connections
  await platformPool.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  ).catch(() => {});

  // DROP DATABASE must be top-level (cannot run inside DO blocks)
  await platformPool.query(`DROP DATABASE IF EXISTS "${name}"`);
  await platformPool.query(`DROP ROLE IF EXISTS "${user}"`);

  log.info({ dbName: name, dbUser: user }, 'Dropped database');
}

/**
 * Get info about a tenant's database (size + tables).
 */
export async function getDatabaseInfo(
  userId: number,
  appName: string,
): Promise<{
  exists: boolean;
  name?: string;
  size?: string;
  tables?: Array<{ name: string; rowCount: number; size: string }>;
}> {
  const name = dbName(userId, appName);
  const user = dbUser(userId, appName);

  try {
    const sizeResult = await platformPool.query(
      `SELECT pg_size_pretty(pg_database_size($1)) as size`,
      [name],
    );
    if (sizeResult.rows.length === 0) return { exists: false };

    // Query table info by connecting as the tenant user's role.
    // We use the platform pool but set the search path to the tenant DB's
    // public schema via a cross-database query. Since tenant DBs are on the
    // same Postgres cluster, we can query pg_catalog tables directly.
    let tables: Array<{ name: string; rowCount: number; size: string }> = [];
    try {
      // Connect to the tenant DB directly via a temporary pool
      const { Pool } = await import('pg');
      const tenantPool = new Pool({
        host: 'postgres',
        port: 5432,
        database: name,
        user: 'cozypane', // superuser can read any DB
        password: process.env.POSTGRES_PASSWORD || 'secret',
        max: 1,
        idleTimeoutMillis: 5000,
      });
      const tablesResult = await tenantPool.query(`
        SELECT
          c.relname AS name,
          c.reltuples::bigint AS row_count,
          pg_size_pretty(pg_total_relation_size(c.oid)) AS size
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
        ORDER BY c.relname
      `);
      tables = tablesResult.rows.map(r => ({
        name: r.name,
        rowCount: parseInt(r.row_count) || 0,
        size: r.size,
      }));
      await tenantPool.end();
    } catch (err: any) {
      log.warn({ dbName: name, err: err.message }, 'Failed to query tenant DB tables');
    }

    return {
      exists: true,
      name,
      size: sizeResult.rows[0].size,
      tables,
    };
  } catch {
    return { exists: false };
  }
}

/**
 * Get infrastructure-level database status (Postgres + Redis).
 */
export async function getInfrastructureStatus(): Promise<{
  postgres: { status: string; version?: string; databases: number; totalSize?: string };
  redis: { status: string; keys?: number; memory?: string };
}> {
  let postgres = { status: 'unknown' as string, version: undefined as string | undefined, databases: 0, totalSize: undefined as string | undefined };
  let redis = { status: 'unknown' as string, keys: undefined as number | undefined, memory: undefined as string | undefined };

  try {
    const versionResult = await platformPool.query('SELECT version()');
    const dbCountResult = await platformPool.query("SELECT COUNT(*) as cnt FROM pg_database WHERE datname LIKE 'cp_%'");
    const sizeResult = await platformPool.query("SELECT pg_size_pretty(SUM(pg_database_size(datname))) as total FROM pg_database WHERE datname LIKE 'cp_%'");
    postgres = {
      status: 'running',
      version: versionResult.rows[0]?.version?.split(' ').slice(0, 2).join(' ') || 'PostgreSQL',
      databases: parseInt(dbCountResult.rows[0]?.cnt) || 0,
      totalSize: sizeResult.rows[0]?.total || '0 bytes',
    };
  } catch {
    postgres.status = 'unreachable';
  }

  try {
    // Redis check via the existing getRedis or direct connection
    const ioredis = await import('ioredis');
    const Redis = ioredis.default || ioredis;
    const redisClient = new (Redis as any)(process.env.REDIS_URL || 'redis://redis:6379/0', {
      connectTimeout: 3000, lazyConnect: true,
    });
    await redisClient.connect();
    const info = await redisClient.info('memory');
    const keyspace = await redisClient.info('keyspace');
    const memMatch = info.match(/used_memory_human:(\S+)/);
    const keysMatch = keyspace.match(/keys=(\d+)/);
    redis = {
      status: 'running',
      keys: keysMatch ? parseInt(keysMatch[1]) : 0,
      memory: memMatch ? memMatch[1] : undefined,
    };
    await redisClient.quit();
  } catch {
    redis.status = 'unreachable';
  }

  return { postgres, redis };
}

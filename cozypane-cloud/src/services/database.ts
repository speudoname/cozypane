import pg from 'pg';
import { randomBytes } from 'node:crypto';

const { Pool } = pg;

// Connect to the platform database to run admin commands (CREATE DATABASE, CREATE USER, etc.)
// We use the platform's DATABASE_URL which has superuser-like access.
function getPlatformPool(): pg.Pool {
  return new Pool({ connectionString: process.env.DATABASE_URL });
}

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
  const pool = getPlatformPool();
  const name = dbName(userId, appName);
  const user = dbUser(userId, appName);
  const password = randomBytes(24).toString('hex');

  // PostgreSQL host — inside Docker network, the postgres service is reachable by service name
  const host = 'postgres';
  const port = 5432;

  try {
    // Create user (or update password if exists)
    const userExists = await pool.query(
      `SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1`,
      [user],
    );

    // DO blocks don't support bind parameters — use format() with
    // dollar-quoted literals built from validated identifiers only.
    // user/name are derived from userId (int) + appName (alphanumeric), safe for identifiers.
    if (userExists.rows.length > 0) {
      await pool.query(
        `DO $do$ BEGIN EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', '${user}', '${password}'); END $do$`,
      );
    } else {
      await pool.query(
        `DO $do$ BEGIN EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', '${user}', '${password}'); END $do$`,
      );
    }

    // Create database if it doesn't exist
    const dbExists = await pool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [name],
    );

    if (dbExists.rows.length === 0) {
      await pool.query(
        `DO $do$ BEGIN EXECUTE format('CREATE DATABASE %I OWNER %I', '${name}', '${user}'); END $do$`,
      );
    } else {
      await pool.query(
        `DO $do$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO %I', '${name}', '${user}'); END $do$`,
      );
    }

    // Grant permissions
    await pool.query(
      `DO $do$ BEGIN EXECUTE format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', '${name}', '${user}'); END $do$`,
    );

    const connectionString = `postgresql://${user}:${password}@${host}:${port}/${name}`;

    console.log(`Provisioned database: ${name} for user ${user}`);

    return { name, user, password, host, port, connectionString };
  } finally {
    await pool.end();
  }
}

/**
 * Drop a tenant's database and user.
 * Used when deleting a deployment.
 */
export async function dropDatabase(
  userId: number,
  appName: string,
): Promise<void> {
  const pool = getPlatformPool();
  const name = dbName(userId, appName);
  const user = dbUser(userId, appName);

  try {
    // Terminate active connections
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    ).catch(() => {});

    // Drop database
    await pool.query(
      `DO $do$ BEGIN EXECUTE format('DROP DATABASE IF EXISTS %I', '${name}'); END $do$`,
    );

    // Drop user
    await pool.query(
      `DO $do$ BEGIN EXECUTE format('DROP ROLE IF EXISTS %I', '${user}'); END $do$`,
    );

    console.log(`Dropped database: ${name} and user: ${user}`);
  } finally {
    await pool.end();
  }
}

/**
 * Get info about a tenant's database (for admin panel).
 */
export async function getDatabaseInfo(
  userId: number,
  appName: string,
): Promise<{ exists: boolean; size?: string }> {
  const pool = getPlatformPool();
  const name = dbName(userId, appName);

  try {
    const result = await pool.query(
      `SELECT pg_size_pretty(pg_database_size($1)) as size`,
      [name],
    );
    if (result.rows.length > 0) {
      return { exists: true, size: result.rows[0].size };
    }
    return { exists: false };
  } catch {
    return { exists: false };
  } finally {
    await pool.end();
  }
}

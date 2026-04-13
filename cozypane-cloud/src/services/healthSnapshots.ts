import type { FastifyBaseLogger } from 'fastify';
import { pool } from '../db/index.js';
import { getQueueStats } from './deployQueue.js';

/**
 * Capture a point-in-time health snapshot and persist it to the
 * health_snapshots table. Called on a 15-minute interval from index.ts.
 * Old rows (>7 days) are pruned on every capture.
 */
export async function captureHealthSnapshot(log: FastifyBaseLogger): Promise<void> {
  try {
    const [queueStats, deploymentCounts, dbConnResult] = await Promise.all([
      getQueueStats(),
      pool.query<{ status: string; count: number }>(
        `SELECT status, COUNT(*)::int AS count FROM deployments WHERE status IN ('running','failed') GROUP BY status`,
      ),
      pool.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM pg_stat_activity WHERE datname = current_database()`,
      ),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of deploymentCounts.rows) byStatus[row.status] = row.count;

    const memoryUsedMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

    // Optional Sentry error count
    let sentryErrors = 0;
    const sentryToken = process.env.SENTRY_AUTH_TOKEN;
    if (sentryToken) {
      try {
        const resp = await fetch(
          'https://sentry.io/api/0/projects/stapilo/cozypane-cloud/issues/?statsPeriod=24h&query=is:unresolved&limit=1',
          { headers: { Authorization: `Bearer ${sentryToken}` } },
        );
        const hits = resp.headers.get('X-Hits');
        if (hits) sentryErrors = parseInt(hits, 10) || 0;
      } catch {
        // Sentry unavailable — default to 0
      }
    }

    await pool.query(
      `INSERT INTO health_snapshots
         (sentry_errors, queue_active, queue_failed, db_connections, deployments_running, deployments_failed, memory_used_mb)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sentryErrors,
        queueStats.active || 0,
        queueStats.failed || 0,
        dbConnResult.rows[0]?.cnt || 0,
        byStatus.running || 0,
        byStatus.failed || 0,
        memoryUsedMb,
      ],
    );

    // Prune old snapshots
    await pool.query(`DELETE FROM health_snapshots WHERE captured_at < NOW() - INTERVAL '7 days'`);
  } catch (err) {
    log.error({ err }, 'Failed to capture health snapshot');
  }
}

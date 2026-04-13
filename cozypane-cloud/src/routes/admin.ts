import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { adminAuth } from '../middleware/adminAuth.js';
import { stopContainer, restartContainer, getContainerLogs, getDockerHealth, docker } from '../services/container.js';
import { cleanupDeployment } from '../services/cleanup.js';
import { checkUserRateLimit } from '../middleware/rateLimit.js';
import { DOMAIN, appUrl, serializeDeploymentSummary, serializeDeploymentDetail } from '../services/serializers.js';
import { getInfrastructureStatus } from '../services/database.js';
import { getQueueStats, getFailedJobs } from '../services/deployQueue.js';
import { pool } from '../db/index.js';
import { idParamSchema } from '../services/schemas.js';
import { getUserCount, listUsersWithCounts, getUserById, updateAdminFlag, deleteUser } from '../db/users.js';
import {
  getDeploymentStats, listDeploymentsAdmin, getDeploymentDetailAdmin,
  getDeploymentContainerId, updateDeploymentStatusStopped, updateDeploymentStatusRunning,
  getDeploymentForCleanup, deleteDeployment, countUserDeployments,
  getDeploymentsForUserCleanup, getUserDeploymentsList,
} from '../db/deployments.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // All routes require admin auth
  app.addHook('preHandler', adminAuth);

  // Dashboard stats
  app.get('/admin/stats', async () => {
    const [totalUsers, deploymentStats] = await Promise.all([
      getUserCount(),
      getDeploymentStats(),
    ]);

    return {
      totalUsers,
      ...deploymentStats,
    };
  });

  // --- Users ---

  app.get<{ Querystring: { page?: string; limit?: string; search?: string } }>(
    '/admin/users',
    async (request) => {
      const page = Math.max(1, parseInt(request.query.page || '1'));
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '20')));
      const offset = (page - 1) * limit;
      const search = request.query.search || '';

      const { users: rows, total } = await listUsersWithCounts(search, limit, offset);

      return {
        users: rows.map((u: any) => ({
          id: u.id,
          username: u.username,
          avatarUrl: u.avatar_url,
          githubId: u.github_id,
          isAdmin: u.is_admin,
          createdAt: u.created_at,
          updatedAt: u.updated_at,
          deploymentCount: parseInt(u.deployment_count),
          runningCount: parseInt(u.running_count),
        })),
        total, page, limit,
      };
    },
  );

  app.get<{ Params: { id: string } }>('/admin/users/:id', { schema: idParamSchema }, async (request, reply) => {
    const [user, deployments] = await Promise.all([
      getUserById(request.params.id),
      getUserDeploymentsList(request.params.id),
    ]);
    if (!user) return reply.code(404).send({ error: 'User not found' });

    return {
      id: user.id,
      username: user.username,
      avatarUrl: user.avatar_url,
      githubId: user.github_id,
      isAdmin: user.is_admin,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      deployments: deployments.map((d: any) => serializeDeploymentSummary(d)),
    };
  });

  app.put<{ Params: { id: string }; Body: { is_admin: boolean } }>(
    '/admin/users/:id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['is_admin'],
          additionalProperties: false,
          properties: {
            is_admin: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      if (parseInt(request.params.id, 10) === request.user.id) {
        return reply.code(400).send({ error: 'Cannot modify your own admin status' });
      }
      const { is_admin } = request.body;
      const result = await updateAdminFlag(request.params.id, is_admin);
      if (!result) return reply.code(404).send({ error: 'User not found' });
      return result;
    },
  );

  app.delete<{ Params: { id: string } }>('/admin/users/:id', { schema: idParamSchema }, async (request, reply) => {
    if (!checkUserRateLimit(request.user.id, 'admin-delete', 5, 60_000)) {
      return reply.code(429).send({ error: 'Rate limit exceeded for destructive operations' });
    }
    const userId = parseInt(request.params.id, 10);
    if (Number.isNaN(userId)) return reply.code(400).send({ error: 'Invalid user id' });
    if (userId === request.user.id) {
      return reply.code(400).send({ error: 'Cannot delete your own account' });
    }
    const errors: string[] = [];

    // Get all deployments for cleanup
    const deps = await getDeploymentsForUserCleanup(userId);

    // Clean up all deployments in parallel — defer network cleanup to a
    // single pass after all containers are removed.
    const results = await Promise.allSettled(
      deps.map(d => cleanupDeployment(d, { cleanNetwork: false })),
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.warnings.length) errors.push(...r.value.warnings);
      if (r.status === 'rejected') errors.push(String(r.reason));
    }

    // Single network-cleanup pass at the end.
    const { warnings: netWarnings } = await cleanupDeployment(
      { user_id: userId, app_name: '', container_id: null, db_name: null },
      { removeImageTag: false, cleanNetwork: true },
    );
    if (netWarnings.length) errors.push(...netWarnings);

    const deleted = await deleteUser(request.params.id);
    if (!deleted) return reply.code(404).send({ error: 'User not found' });
    return { ok: true, ...(errors.length > 0 ? { warnings: errors } : {}) };
  });

  // --- Deployments ---

  app.get<{ Querystring: { page?: string; limit?: string; status?: string; user_id?: string } }>(
    '/admin/deployments',
    async (request) => {
      const page = Math.max(1, parseInt(request.query.page || '1'));
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '20')));
      const offset = (page - 1) * limit;

      const { deployments: rows, total } = await listDeploymentsAdmin(
        { status: request.query.status, userId: request.query.user_id },
        limit,
        offset,
      );

      return {
        deployments: rows.map((r: any) => ({
          ...serializeDeploymentSummary(r),
          containerId: r.container_id || null,
          dbName: r.db_name || null,
          username: r.username,
          avatarUrl: r.avatar_url,
        })),
        total,
        page,
        limit,
      };
    },
  );

  app.get<{ Params: { id: string } }>('/admin/deployments/:id', { schema: idParamSchema }, async (request, reply) => {
    // Explicit column list rather than `d.*` — admin deployment detail was
    // previously leaking build_log (which may contain secrets) and raw
    // db_user/db_host values via `...row` spread.
    const row = await getDeploymentDetailAdmin(request.params.id);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });
    return {
      ...serializeDeploymentDetail(row),
      // Admin-only fields: raw identifiers needed by the admin SPA
      containerId: row.container_id,
      dbName: row.db_name,
      dbHost: row.db_host,
      userId: row.user_id,
      username: row.username,
      avatarUrl: row.avatar_url,
    };
  });

  app.post<{ Params: { id: string } }>('/admin/deployments/:id/stop', { schema: idParamSchema }, async (request, reply) => {
    const dep = await getDeploymentContainerId(request.params.id);
    if (!dep) return reply.code(404).send({ error: 'Deployment not found' });
    if (dep.container_id) {
      try {
        await stopContainer(dep.container_id);
      } catch (err: any) {
        return reply.code(500).send({ error: 'Failed to stop container' });
      }
    }
    await updateDeploymentStatusStopped(request.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/admin/deployments/:id/restart', { schema: idParamSchema }, async (request, reply) => {
    const dep = await getDeploymentContainerId(request.params.id);
    if (!dep) return reply.code(404).send({ error: 'Deployment not found' });
    if (!dep.container_id) return reply.code(400).send({ error: 'No container to restart' });

    try {
      await restartContainer(dep.container_id);
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to restart container' });
    }
    await updateDeploymentStatusRunning(request.params.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/admin/deployments/:id', { schema: idParamSchema }, async (request, reply) => {
    const dep = await getDeploymentForCleanup(request.params.id);
    if (!dep) return reply.code(404).send({ error: 'Deployment not found' });

    // Full cleanup sequence (stop, drop DB, remove image). Skip network
    // cleanup here so we can check deployment-count first.
    const { warnings } = await cleanupDeployment(dep, { cleanNetwork: false });

    // Delete from DB
    await deleteDeployment(dep.id);

    // Clean up user network only if no more deployments remain for this user.
    const remaining = await countUserDeployments(dep.user_id);
    if (remaining === 0) {
      const { warnings: netWarnings } = await cleanupDeployment(
        { user_id: dep.user_id, app_name: '', container_id: null, db_name: null },
        { removeImageTag: false, cleanNetwork: true },
      );
      if (netWarnings.length) warnings.push(...netWarnings);
    }

    return { ok: true, ...(warnings.length > 0 ? { warnings } : {}) };
  });

  // --- Health ---

  app.get('/admin/health', async (req, reply) => {
    const [infraStatus, dockerHealth, queueStats, deploymentStats] = await Promise.all([
      getInfrastructureStatus(),
      getDockerHealth(),
      getQueueStats(),
      pool.query(`
        SELECT status, COUNT(*)::int as count FROM deployments GROUP BY status
        UNION ALL
        SELECT 'recentErrors', COUNT(*)::int FROM deployments
        WHERE status IN ('failed', 'error') AND updated_at > NOW() - INTERVAL '24 hours'
      `),
    ]);

    const mem = process.memoryUsage();
    const byStatus: Record<string, number> = {};
    for (const row of deploymentStats.rows) byStatus[row.status] = row.count;

    return {
      server: {
        status: 'running',
        uptime: Math.floor(process.uptime()),
        nodeVersion: process.version,
        memoryUsage: {
          rss: `${Math.round(mem.rss / 1024 / 1024)} MB`,
          heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`,
          heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)} MB`,
        },
      },
      postgres: {
        status: infraStatus.postgres ? 'running' : 'unreachable',
        version: infraStatus.postgres?.version,
        databases: infraStatus.postgres?.databases,
        totalSize: infraStatus.postgres?.totalSize,
        poolSize: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      },
      redis: {
        status: infraStatus.redis ? 'running' : 'unreachable',
        keys: infraStatus.redis?.keys,
        memory: infraStatus.redis?.memory,
      },
      docker: dockerHealth,
      deployments: {
        total: Object.entries(byStatus).filter(([k]) => k !== 'recentErrors').reduce((s, [, v]) => s + v, 0),
        running: byStatus.running || 0,
        building: byStatus.building || 0,
        failed: byStatus.failed || 0,
        stopped: byStatus.stopped || 0,
        recentErrors: byStatus.recentErrors || 0,
      },
      queue: queueStats,
    };
  });

  // --- Sentry issues (both projects) ---

  app.get<{ Querystring: { period?: string } }>('/admin/health/sentry', async (request) => {
    const period = request.query.period || '24h';
    const token = process.env.SENTRY_AUTH_TOKEN;
    if (!token) return { issues: [], error: 'SENTRY_AUTH_TOKEN not configured' };

    const projects = ['cozypane-desktop', 'cozypane-cloud'];
    const results = await Promise.allSettled(
      projects.map(async (proj) => {
        const resp = await fetch(
          `https://sentry.io/api/0/projects/stapilo/${proj}/issues/?statsPeriod=${encodeURIComponent(period)}&query=is:unresolved&limit=50`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!resp.ok) throw new Error(`Sentry ${proj}: HTTP ${resp.status}`);
        const issues = (await resp.json()) as any[];
        return issues.map((i: any) => ({
          id: i.id,
          shortId: i.shortId,
          title: i.title,
          count: parseInt(i.count) || 0,
          userCount: parseInt(i.userCount) || 0,
          lastSeen: i.lastSeen,
          project: proj,
          permalink: i.permalink,
        }));
      }),
    );

    const merged: any[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') merged.push(...r.value);
    }
    merged.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
    return { issues: merged.slice(0, 50) };
  });

  // --- Failed queue jobs ---

  app.get('/admin/health/queues/failed', async () => {
    const [counts, failedJobs] = await Promise.all([
      getQueueStats(),
      getFailedJobs(),
    ]);
    return {
      queues: [{
        name: 'deploy-builds',
        counts,
        failedJobs,
      }],
    };
  });

  // --- Server metrics ---

  app.get('/admin/health/server', async () => {
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus();

    let disk: { filesystem?: string; size?: string; used?: string; available?: string; usePercent?: string; mount?: string } = {};
    try {
      const dfOutput = execSync('df -h /').toString();
      const lines = dfOutput.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        disk = {
          filesystem: parts[0],
          size: parts[1],
          used: parts[2],
          available: parts[3],
          usePercent: parts[4],
          mount: parts[5],
        };
      }
    } catch {
      // df not available
    }

    let containers: any[] = [];
    try {
      containers = await docker.listContainers({ all: true });
    } catch {
      // Docker unavailable
    }

    return {
      os: {
        platform: os.platform(),
        arch: os.arch(),
        uptime: os.uptime(),
        loadAvg,
      },
      memory: {
        totalMb: Math.round(totalMem / 1024 / 1024),
        freeMb: Math.round(freeMem / 1024 / 1024),
        usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
      },
      cpus: {
        count: cpus.length,
        model: cpus[0]?.model || 'unknown',
      },
      disk,
      docker: {
        containers: containers.map(c => ({
          id: c.Id?.slice(0, 12),
          names: c.Names,
          image: c.Image,
          state: c.State,
          status: c.Status,
        })),
      },
    };
  });

  // --- Database details ---

  app.get('/admin/health/database', async () => {
    const [tablesResult, connResult] = await Promise.all([
      pool.query(`
        SELECT schemaname||'.'||relname AS name,
               n_live_tup AS estimated_rows,
               pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
               n_dead_tup AS dead_tuples,
               last_vacuum,
               last_autovacuum
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
      `),
      pool.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM pg_stat_activity WHERE datname = current_database()`,
      ),
    ]);

    let slowQueries: any[] = [];
    try {
      const sqResult = await pool.query(`
        SELECT LEFT(query, 200) AS query,
               calls,
               total_exec_time AS total_time_ms,
               mean_exec_time AS mean_time_ms
        FROM pg_stat_statements
        ORDER BY total_exec_time DESC
        LIMIT 10
      `);
      slowQueries = sqResult.rows;
    } catch {
      // pg_stat_statements extension may not be enabled
    }

    return {
      tables: tablesResult.rows,
      slowQueries,
      connections: connResult.rows[0]?.cnt || 0,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  });

  // --- Smoke test ---

  app.post('/admin/health/smoke-test', async () => {
    const tests = await Promise.allSettled([
      // Postgres
      (async () => {
        const start = Date.now();
        await pool.query('SELECT 1');
        return { service: 'postgres', status: 'ok' as const, latencyMs: Date.now() - start };
      })(),
      // Redis
      (async () => {
        const start = Date.now();
        const ioredis = await import('ioredis');
        const Redis = ioredis.default || ioredis;
        const client = new (Redis as any)(process.env.REDIS_URL || 'redis://redis:6379/0', {
          connectTimeout: 5000, lazyConnect: true,
        });
        try {
          await client.connect();
          await client.ping();
          return { service: 'redis', status: 'ok' as const, latencyMs: Date.now() - start };
        } finally {
          await client.quit().catch(() => {});
        }
      })(),
      // Docker
      (async () => {
        const start = Date.now();
        await docker.ping();
        return { service: 'docker', status: 'ok' as const, latencyMs: Date.now() - start };
      })(),
      // Sentry
      (async () => {
        const token = process.env.SENTRY_AUTH_TOKEN;
        if (!token) return { service: 'sentry', status: 'ok' as const, latencyMs: 0, note: 'skipped (no token)' };
        const start = Date.now();
        const resp = await fetch('https://sentry.io/api/0/organizations/stapilo/', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return { service: 'sentry', status: 'ok' as const, latencyMs: Date.now() - start };
      })(),
    ]);

    const results = tests.map(r => {
      if (r.status === 'fulfilled') return r.value;
      return { service: 'unknown', status: 'failed' as const, latencyMs: 0, error: String(r.reason) };
    });

    return { results, timestamp: new Date().toISOString() };
  });

  // --- App health checks ---

  app.get('/admin/health/app-checks', async () => {
    const { rows } = await pool.query<{ id: number; app_name: string; subdomain: string }>(
      `SELECT id, app_name, subdomain FROM deployments WHERE status = 'running' LIMIT 50`,
    );

    const domain = DOMAIN;
    const batchSize = 10;
    const checks: any[] = [];

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (dep) => {
          const url = `https://${dep.subdomain}.${domain}/`;
          const start = Date.now();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            const resp = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            return {
              id: dep.id,
              appName: dep.app_name,
              subdomain: dep.subdomain,
              url,
              httpStatus: resp.status,
              responseTimeMs: Date.now() - start,
            };
          } catch (err: any) {
            clearTimeout(timeout);
            return {
              id: dep.id,
              appName: dep.app_name,
              subdomain: dep.subdomain,
              url,
              httpStatus: null,
              responseTimeMs: Date.now() - start,
              error: err.name === 'AbortError' ? 'Timeout (5s)' : err.message,
            };
          }
        }),
      );

      for (const r of results) {
        checks.push(r.status === 'fulfilled' ? r.value : { error: String(r.reason) });
      }
    }

    return { checks };
  });

  // --- Health snapshots time-series ---

  app.get<{ Querystring: { hours?: string } }>('/admin/health/snapshots', async (request) => {
    const rawHours = parseInt(request.query.hours || '48', 10);
    const hours = Math.min(Math.max(1, isNaN(rawHours) ? 48 : rawHours), 168);

    const { rows } = await pool.query(
      `SELECT * FROM health_snapshots WHERE captured_at > NOW() - make_interval(hours => $1) ORDER BY captured_at ASC`,
      [hours],
    );
    return { snapshots: rows, hours };
  });

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    '/admin/deployments/:id/logs',
    { schema: idParamSchema },
    async (request, reply) => {
      const dep = await getDeploymentContainerId(request.params.id);
      if (!dep) return reply.code(404).send({ error: 'Deployment not found' });
      if (!dep.container_id) return reply.code(400).send({ error: 'No container running' });

      // Cap at 10000 lines — matches the user-facing /deploy/:id/logs cap
      // and prevents an admin `tail=999999999` from OOMing the API.
      const rawTail = parseInt(request.query.tail || '500', 10);
      const tail = Math.min(isNaN(rawTail) ? 500 : rawTail, 10000);
      const logs = await getContainerLogs(dep.container_id, tail);
      return { logs };
    },
  );
}

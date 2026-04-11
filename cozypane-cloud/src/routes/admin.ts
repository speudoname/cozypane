import type { FastifyInstance } from 'fastify';
import { query } from '../db/index.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { stopContainer, restartContainer, getContainerLogs } from '../services/container.js';
import { cleanupDeployment } from '../services/cleanup.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // All routes require admin auth
  app.addHook('preHandler', adminAuth);

  // Dashboard stats
  app.get('/admin/stats', async () => {
    const [users, deployments, byStatus, byTier, databases] = await Promise.all([
      query('SELECT COUNT(*) as count FROM users'),
      query('SELECT COUNT(*) as count FROM deployments'),
      query(`SELECT status, COUNT(*) as count FROM deployments GROUP BY status`),
      query(`SELECT tier, COUNT(*) as count FROM deployments GROUP BY tier`),
      query(`SELECT COUNT(*) as count FROM deployments WHERE db_name IS NOT NULL`),
    ]);

    return {
      totalUsers: parseInt(users.rows[0].count),
      totalDeployments: parseInt(deployments.rows[0].count),
      totalDatabases: parseInt(databases.rows[0].count),
      byStatus: Object.fromEntries(byStatus.rows.map(r => [r.status, parseInt(r.count)])),
      byTier: Object.fromEntries(byTier.rows.map(r => [r.tier, parseInt(r.count)])),
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

      let where = '';
      const params: any[] = [];
      if (search) {
        params.push(`%${search}%`);
        where = `WHERE u.username ILIKE $${params.length}`;
      }

      const countResult = await query(
        `SELECT COUNT(*) FROM users u ${where}`,
        params,
      );
      const total = parseInt(countResult.rows[0].count);

      const result = await query(
        `SELECT u.id, u.username, u.avatar_url, u.github_id, u.is_admin, u.created_at, u.updated_at,
                COUNT(d.id) as deployment_count,
                COUNT(d.id) FILTER (WHERE d.status = 'running') as running_count
         FROM users u
         LEFT JOIN deployments d ON d.user_id = u.id
         ${where}
         GROUP BY u.id
         ORDER BY u.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      );

      return { users: result.rows, total, page, limit };
    },
  );

  app.get<{ Params: { id: string } }>('/admin/users/:id', async (request, reply) => {
    const result = await query(
      `SELECT id, username, avatar_url, github_id, is_admin, created_at, updated_at
       FROM users WHERE id = $1`,
      [request.params.id],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'User not found' });

    const deployments = await query(
      `SELECT id, app_name, subdomain, status, project_type, tier, port, created_at, updated_at
       FROM deployments WHERE user_id = $1 ORDER BY updated_at DESC`,
      [request.params.id],
    );

    return { ...result.rows[0], deployments: deployments.rows };
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
      const { is_admin } = request.body;
      const result = await query(
        `UPDATE users SET is_admin = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, is_admin`,
        [is_admin, request.params.id],
      );
      if (!result.rows[0]) return reply.code(404).send({ error: 'User not found' });
      return result.rows[0];
    },
  );

  app.delete<{ Params: { id: string } }>('/admin/users/:id', async (request, reply) => {
    const userId = parseInt(request.params.id, 10);
    if (Number.isNaN(userId)) return reply.code(400).send({ error: 'Invalid user id' });
    const errors: string[] = [];

    // Get all deployments for cleanup
    const deps = await query(
      'SELECT id, container_id, app_name, db_name, user_id FROM deployments WHERE user_id = $1',
      [userId],
    );

    for (const d of deps.rows) {
      // Defer network cleanup to a single pass after the loop so we don't
      // flap the per-user network between deployments.
      const { warnings } = await cleanupDeployment(d, { cleanNetwork: false });
      if (warnings.length) errors.push(...warnings);
    }

    // Single network-cleanup pass at the end.
    const { warnings: netWarnings } = await cleanupDeployment(
      { user_id: userId, app_name: '', container_id: null, db_name: null },
      { removeImageTag: false, cleanNetwork: true },
    );
    if (netWarnings.length) errors.push(...netWarnings);

    const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [request.params.id]);
    if (!result.rows[0]) return reply.code(404).send({ error: 'User not found' });
    return { ok: true, ...(errors.length > 0 ? { warnings: errors } : {}) };
  });

  // --- Deployments ---

  app.get<{ Querystring: { page?: string; limit?: string; status?: string; user_id?: string } }>(
    '/admin/deployments',
    async (request) => {
      const page = Math.max(1, parseInt(request.query.page || '1'));
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '20')));
      const offset = (page - 1) * limit;

      const conditions: string[] = [];
      const params: any[] = [];

      if (request.query.status) {
        params.push(request.query.status);
        conditions.push(`d.status = $${params.length}`);
      }
      if (request.query.user_id) {
        params.push(request.query.user_id);
        conditions.push(`d.user_id = $${params.length}`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await query(`SELECT COUNT(*) FROM deployments d ${where}`, params);
      const total = parseInt(countResult.rows[0].count);

      const domain = process.env.DOMAIN || 'cozypane.com';
      const result = await query(
        `SELECT d.id, d.app_name, d.subdomain, d.status, d.project_type, d.tier, d.port,
                d.container_id, d.db_name, d.db_user, d.db_host,
                d.created_at, d.updated_at,
                u.username, u.avatar_url
         FROM deployments d
         JOIN users u ON u.id = d.user_id
         ${where}
         ORDER BY d.updated_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      );

      // Whitelist fields — do NOT spread `...r` which leaks internal column
      // names (db_user, db_host, db_name) and potential secrets in build_log.
      return {
        deployments: result.rows.map(r => ({
          id: r.id,
          appName: r.app_name,
          subdomain: r.subdomain,
          status: r.status,
          projectType: r.project_type,
          tier: r.tier,
          port: r.port,
          hasContainer: !!r.container_id,
          hasDatabase: !!r.db_name,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          username: r.username,
          avatarUrl: r.avatar_url,
          url: `https://${r.subdomain}.${domain}`,
        })),
        total,
        page,
        limit,
      };
    },
  );

  app.get<{ Params: { id: string } }>('/admin/deployments/:id', async (request, reply) => {
    const domain = process.env.DOMAIN || 'cozypane.com';
    // Explicit column list rather than `d.*` — admin deployment detail was
    // previously leaking build_log (which may contain secrets) and raw
    // db_user/db_host values via `...row` spread.
    const result = await query(
      `SELECT d.id, d.app_name, d.subdomain, d.status, d.project_type, d.tier, d.port,
              d.container_id, d.db_name, d.db_host, d.deploy_group, d.framework,
              d.deploy_phase, d.detected_port, d.detected_database, d.error_detail,
              d.created_at, d.updated_at,
              u.id AS user_id, u.username, u.avatar_url
       FROM deployments d JOIN users u ON u.id = d.user_id
       WHERE d.id = $1`,
      [request.params.id],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'Deployment not found' });
    const row = result.rows[0];
    return {
      id: row.id,
      appName: row.app_name,
      subdomain: row.subdomain,
      status: row.status,
      projectType: row.project_type,
      tier: row.tier,
      port: row.port,
      hasContainer: !!row.container_id,
      hasDatabase: !!row.db_name,
      deployGroup: row.deploy_group,
      framework: row.framework,
      deployPhase: row.deploy_phase,
      detectedPort: row.detected_port,
      detectedDatabase: row.detected_database,
      errorDetail: row.error_detail,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      userId: row.user_id,
      username: row.username,
      avatarUrl: row.avatar_url,
      url: `https://${row.subdomain}.${domain}`,
    };
  });

  app.post<{ Params: { id: string } }>('/admin/deployments/:id/stop', async (request, reply) => {
    const result = await query('SELECT container_id FROM deployments WHERE id = $1', [request.params.id]);
    if (!result.rows[0]) return reply.code(404).send({ error: 'Deployment not found' });
    if (result.rows[0].container_id) {
      try {
        await stopContainer(result.rows[0].container_id);
      } catch (err: any) {
        return reply.code(500).send({ error: `Failed to stop container: ${err.message}` });
      }
    }
    await query(`UPDATE deployments SET status = 'stopped', container_id = NULL, updated_at = NOW() WHERE id = $1`, [request.params.id]);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/admin/deployments/:id/restart', async (request, reply) => {
    const result = await query('SELECT container_id FROM deployments WHERE id = $1', [request.params.id]);
    if (!result.rows[0]) return reply.code(404).send({ error: 'Deployment not found' });
    if (!result.rows[0].container_id) return reply.code(400).send({ error: 'No container to restart' });

    await restartContainer(result.rows[0].container_id);
    await query(`UPDATE deployments SET status = 'running', updated_at = NOW() WHERE id = $1`, [request.params.id]);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/admin/deployments/:id', async (request, reply) => {
    const result = await query(
      'SELECT d.id, d.container_id, d.app_name, d.db_name, d.user_id, u.username FROM deployments d JOIN users u ON u.id = d.user_id WHERE d.id = $1',
      [request.params.id],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'Deployment not found' });

    const dep = result.rows[0];

    // Full cleanup sequence (stop, drop DB, remove image). Skip network
    // cleanup here so we can check deployment-count first.
    const { warnings } = await cleanupDeployment(dep, { cleanNetwork: false });

    // Delete from DB
    await query('DELETE FROM deployments WHERE id = $1', [dep.id]);

    // Clean up user network only if no more deployments remain for this user.
    const remaining = await query(
      'SELECT COUNT(*) as cnt FROM deployments WHERE user_id = $1',
      [dep.user_id],
    );
    if (parseInt(remaining.rows[0].cnt) === 0) {
      const { warnings: netWarnings } = await cleanupDeployment(
        { user_id: dep.user_id, app_name: '', container_id: null, db_name: null },
        { removeImageTag: false, cleanNetwork: true },
      );
      if (netWarnings.length) warnings.push(...netWarnings);
    }

    return { ok: true, ...(warnings.length > 0 ? { warnings } : {}) };
  });

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    '/admin/deployments/:id/logs',
    async (request, reply) => {
      const result = await query('SELECT container_id FROM deployments WHERE id = $1', [request.params.id]);
      if (!result.rows[0]) return reply.code(404).send({ error: 'Deployment not found' });
      if (!result.rows[0].container_id) return reply.code(400).send({ error: 'No container running' });

      // Cap at 10000 lines — matches the user-facing /deploy/:id/logs cap
      // and prevents an admin `tail=999999999` from OOMing the API.
      const rawTail = parseInt(request.query.tail || '500', 10);
      const tail = Math.min(isNaN(rawTail) ? 500 : rawTail, 10000);
      const logs = await getContainerLogs(result.rows[0].container_id, tail);
      return { logs };
    },
  );
}

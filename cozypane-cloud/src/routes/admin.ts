import type { FastifyInstance } from 'fastify';
import { query } from '../db/index.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { stopContainer, getContainerLogs, removeImage, removeNetworkIfEmpty } from '../services/container.js';
import { dropDatabase } from '../services/database.js';

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

  app.put<{ Params: { id: string }; Body: { is_admin?: boolean } }>(
    '/admin/users/:id',
    async (request, reply) => {
      const { is_admin } = request.body || {};
      if (typeof is_admin !== 'boolean') {
        return reply.code(400).send({ error: 'Provide is_admin (boolean)' });
      }
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
    const errors: string[] = [];

    // Get all deployments for cleanup
    const deps = await query(
      'SELECT id, container_id, app_name, db_name, user_id FROM deployments WHERE user_id = $1',
      [userId],
    );

    for (const d of deps.rows) {
      // Stop container
      if (d.container_id) {
        try {
          await stopContainer(d.container_id);
        } catch (err: any) {
          errors.push(`container ${d.container_id.slice(0, 12)}: ${err.message}`);
        }
      }
      // Drop provisioned database
      if (d.db_name) {
        try {
          await dropDatabase(d.user_id, d.app_name);
        } catch (err: any) {
          errors.push(`database ${d.db_name}: ${err.message}`);
        }
      }
      // Remove Docker image
      await removeImage(`cozypane/${userId}-${d.app_name}:latest`);
    }

    // Remove user network
    await removeNetworkIfEmpty(userId);

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

      return {
        deployments: result.rows.map(r => ({
          ...r,
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
    const result = await query(
      `SELECT d.*, u.username, u.avatar_url
       FROM deployments d JOIN users u ON u.id = d.user_id
       WHERE d.id = $1`,
      [request.params.id],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'Deployment not found' });
    const row = result.rows[0];
    return { ...row, url: `https://${row.subdomain}.${domain}` };
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

    const Docker = (await import('dockerode')).default;
    const docker = new Docker({ socketPath: '/var/run/docker.sock' });
    const container = docker.getContainer(result.rows[0].container_id);
    await container.restart({ t: 10 });
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
    const errors: string[] = [];

    // Stop and remove container
    if (dep.container_id) {
      try {
        await stopContainer(dep.container_id);
      } catch (err: any) {
        errors.push(`container: ${err.message}`);
      }
    }

    // Drop provisioned database
    if (dep.db_name) {
      try {
        await dropDatabase(dep.user_id, dep.app_name);
      } catch (err: any) {
        errors.push(`database: ${err.message}`);
      }
    }

    // Remove Docker image
    await removeImage(`cozypane/${dep.user_id}-${dep.app_name}:latest`);

    // Delete from DB
    await query('DELETE FROM deployments WHERE id = $1', [dep.id]);

    // Clean up user network if no more deployments
    const remaining = await query(
      'SELECT COUNT(*) as cnt FROM deployments WHERE user_id = $1',
      [dep.user_id],
    );
    if (parseInt(remaining.rows[0].cnt) === 0) {
      await removeNetworkIfEmpty(dep.user_id);
    }

    return { ok: true, ...(errors.length > 0 ? { warnings: errors } : {}) };
  });

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    '/admin/deployments/:id/logs',
    async (request, reply) => {
      const result = await query('SELECT container_id FROM deployments WHERE id = $1', [request.params.id]);
      if (!result.rows[0]) return reply.code(404).send({ error: 'Deployment not found' });
      if (!result.rows[0].container_id) return reply.code(400).send({ error: 'No container running' });

      const tail = parseInt(request.query.tail || '500', 10);
      const logs = await getContainerLogs(result.rows[0].container_id, tail);
      return { logs };
    },
  );
}

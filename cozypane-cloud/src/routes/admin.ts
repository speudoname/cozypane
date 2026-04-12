import type { FastifyInstance } from 'fastify';
import { adminAuth } from '../middleware/adminAuth.js';
import { stopContainer, restartContainer, getContainerLogs } from '../services/container.js';
import { cleanupDeployment } from '../services/cleanup.js';
import { checkUserRateLimit } from '../middleware/rateLimit.js';
import { DOMAIN, appUrl, serializeDeploymentSummary, serializeDeploymentDetail } from '../services/serializers.js';
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

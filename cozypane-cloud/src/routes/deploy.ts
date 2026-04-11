import type { FastifyInstance } from 'fastify';
import { mkdirSync, rmSync } from 'node:fs';
import { join, normalize, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getBuildDataDir } from '../services/buildDataDir.js';
import { createGunzip } from 'node:zlib';
import tar from 'tar-fs';
import { query } from '../db/index.js';
import { getDeployment } from '../db/deployments.js';
import { authenticate } from '../middleware/auth.js';
import { checkUserRateLimit } from '../middleware/rateLimit.js';
import { analyzeProject } from '../services/detector.js';
import {
  restartContainer,
  getContainerLogs,
  streamLogs,
  execInContainer,
} from '../services/container.js';
import { cleanupDeployment } from '../services/cleanup.js';
import { appUrl, serializeDeploymentSummary, serializeDeploymentDetail } from '../services/serializers.js';
import { enqueueDeploy } from '../services/deployQueue.js';

const APP_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export async function deployRoutes(app: FastifyInstance): Promise<void> {
  // POST /deploy — create or redeploy (async: returns immediately, build runs in background)
  app.post('/deploy', {
    preHandler: authenticate,
  }, async (request, reply) => {
    // Per-user rate limit: 5 deploys per minute. See middleware/rateLimit.ts
    // for why this runs in-handler instead of via @fastify/rate-limit.
    if (!checkUserRateLimit(request.user.id, 'deploy', 5, 60_000)) {
      return reply.code(429).send({ error: 'Rate limit exceeded. Try again in a minute.' });
    }
    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: 'Multipart upload with tar file required' });
    }

    // Extract fields from multipart
    const fields = data.fields as Record<string, any>;
    const appName = fieldValue(fields.appName);
    const tierOverride = fieldValue(fields.tier);
    const envJson = fieldValue(fields.env);
    const deployGroup = fieldValue(fields.group);

    if (!appName || !APP_NAME_REGEX.test(appName)) {
      return reply.code(400).send({
        error: 'Invalid app name. Use lowercase alphanumeric characters and hyphens (2-64 chars).',
      });
    }

    const userId = request.user.id;
    const username = request.user.username;
    const subdomain = `${appName}-${username}`;

    // M18 — detect subdomain collision with another user's deployment BEFORE
    // we try to write. The UNIQUE(subdomain) constraint would otherwise
    // surface as a generic 500; we want a clean 409 with an actionable
    // message. Collision is theoretical (would require e.g. user A's
    // "app-oldusername" equals user B's "A-oldapp") but low-probability
    // is not zero, and a 500 is a bad experience for what's a name clash.
    const collisionCheck = await query(
      'SELECT user_id FROM deployments WHERE subdomain = $1',
      [subdomain],
    );
    if (collisionCheck.rowCount && collisionCheck.rows[0].user_id !== userId) {
      return reply.code(409).send({
        error: `Subdomain "${subdomain}" is taken by another user. Choose a different app name.`,
      });
    }

    // Prepare extraction directory on a persistent volume so API container
    // restarts don't wipe in-flight builds mid-flight.
    const tempId = randomBytes(8).toString('hex');
    const tempDir = join(getBuildDataDir(), `cozypane-deploy-${tempId}`);
    const extractDir = join(tempDir, 'project');
    mkdirSync(extractDir, { recursive: true });

    // Stream the upload directly into gunzip → tar-extract, no intermediate
    // on-disk copy. Previously this wrote a `.tar.gz` file to the tempdir and
    // then re-read it for extraction (+ re-tarred it again for the Docker
    // build context), so a 100 MB upload incurred ~300 MB of I/O. Audit M16.
    try {
      await new Promise<void>((resolve, reject) => {
        const gunzip = createGunzip();
        const extract = tar.extract(extractDir, {
          filter(name) {
            const normalized = normalize(name);
            if (isAbsolute(normalized) || normalized.startsWith('..')) return false;
            return true;
          },
          map(header) {
            header.name = normalize(header.name);
            return header;
          },
        });
        data.file.pipe(gunzip).pipe(extract);
        extract.on('finish', resolve);
        extract.on('error', reject);
        gunzip.on('error', reject);
        data.file.on('error', reject);
      });
    } catch (err: any) {
      rmSync(tempDir, { recursive: true, force: true });
      return reply.code(400).send({ error: `Failed to process upload: ${err.message}` });
    }

    // Run server-side detection
    const analysis = analyzeProject(extractDir);
    const tier = tierOverride || analysis.recommendedTier;

    if (!['small', 'medium', 'large'].includes(tier)) {
      rmSync(tempDir, { recursive: true, force: true });
      return reply.code(400).send({ error: 'Invalid tier. Must be small, medium, or large.' });
    }

    // Check per-user deployment limit
    const countResult = await query(
      `SELECT COUNT(*) AS cnt FROM deployments WHERE user_id = $1 AND status NOT IN ('failed') AND app_name != $2`,
      [userId, appName],
    );
    if (parseInt(countResult.rows[0].cnt, 10) >= 10) {
      rmSync(tempDir, { recursive: true, force: true });
      return reply.code(400).send({ error: 'Deployment limit reached (max 10 active deployments)' });
    }

    // Upsert deployment record — status 'building', store analysis metadata
    const result = await query(
      `INSERT INTO deployments (user_id, app_name, subdomain, status, project_type, tier, port, deploy_group, framework, deploy_phase, detected_port, detected_database)
       VALUES ($1, $2, $3, 'building', $4, $5, $6, $7, $8, 'detecting', $9, $10)
       ON CONFLICT (user_id, app_name) DO UPDATE SET
         status = 'building',
         project_type = EXCLUDED.project_type,
         tier = EXCLUDED.tier,
         port = EXCLUDED.port,
         deploy_group = EXCLUDED.deploy_group,
         framework = EXCLUDED.framework,
         deploy_phase = 'detecting',
         detected_port = EXCLUDED.detected_port,
         detected_database = EXCLUDED.detected_database,
         error_detail = NULL,
         build_log = NULL,
         updated_at = NOW()
       RETURNING id`,
      [userId, appName, subdomain, analysis.type, tier, analysis.port, deployGroup || null,
       analysis.framework, analysis.port, analysis.needsDatabase],
    );
    const deploymentId = result.rows[0].id;

    // M23 — enqueue the build on the BullMQ-backed deploy queue. The
    // worker lives in-process (see services/deployQueue.ts) so the HTTP
    // response still returns immediately while the queue schedules the
    // actual build. Benefits over the old fire-and-forget:
    //   * concurrency cap (DEPLOY_QUEUE_CONCURRENCY, default 4)
    //   * stalled-job recovery on API crash
    //   * graceful drain on SIGTERM (index.ts)
    await enqueueDeploy({
      deploymentId,
      extractDir,
      tempDir,
      analysis,
      appName,
      subdomain,
      tier,
      userId,
      envJson,
    });

    return {
      id: deploymentId,
      subdomain,
      url: appUrl(subdomain),
      status: 'building',
      phase: 'detecting',
      framework: analysis.framework,
      detectedPort: analysis.port,
      detectedDatabase: analysis.needsDatabase,
      recommendedTier: analysis.recommendedTier,
      projectType: analysis.type,
      ...(analysis.warnings.length > 0 ? { warnings: analysis.warnings } : {}),
    };
  });

  // GET /deploy/list — user's deployments (hard-capped at 100 rows to avoid
  // unbounded scans if the per-user deployment limit is ever raised).
  app.get('/deploy/list', { preHandler: authenticate }, async (request) => {
    const result = await query(
      `SELECT id, app_name, subdomain, status, project_type, tier, port, container_id,
              db_name, deploy_group, framework, deploy_phase, error_detail,
              detected_port, detected_database, created_at, updated_at
       FROM deployments WHERE user_id = $1 ORDER BY deploy_group NULLS LAST, updated_at DESC
       LIMIT 100`,
      [request.user.id],
    );
    return result.rows.map((row) => serializeDeploymentSummary(row));
  });

  // GET /deploy/:id — deployment detail
  app.get<{ Params: { id: string } }>(
    '/deploy/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const result = await query(
        `SELECT d.*, array_agg(json_build_object('domain', dm.domain, 'verified', dm.verified))
           FILTER (WHERE dm.id IS NOT NULL) AS custom_domains
         FROM deployments d
         LEFT JOIN domains dm ON dm.deployment_id = d.id
         WHERE d.id = $1 AND d.user_id = $2
         GROUP BY d.id`,
        [request.params.id, request.user.id],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      // Canonical serializer (see services/serializers.ts) — same shape
      // as admin detail + list endpoints; no drift possible.
      const row = result.rows[0];
      return serializeDeploymentDetail({
        ...row,
        customDomains: row.custom_domains || [],
      });
    },
  );

  // GET /deploy/:id/logs — container logs + build logs
  app.get<{ Params: { id: string }; Querystring: { tail?: string; type?: string } }>(
    '/deploy/:id/logs',
    { preHandler: authenticate },
    async (request, reply) => {
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      // Return build logs if requested or if no container is running
      if (request.query.type === 'build' || !deployment.container_id) {
        return {
          logs: deployment.build_log || 'No build logs available',
          type: 'build',
        };
      }

      const tail = Math.min(parseInt(request.query.tail || '200', 10), 10000);
      const logs = await getContainerLogs(deployment.container_id, tail);
      return { logs, type: 'runtime' };
    },
  );

  // DELETE /deploy/:id — stop and remove
  app.delete<{ Params: { id: string } }>(
    '/deploy/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      // Full cleanup sequence: stop container, drop tenant DB, remove Docker
      // image tag, remove per-user network if empty. The user-initiated path
      // previously only did the first two, leaking images and networks.
      const { warnings } = await cleanupDeployment({
        user_id: request.user.id,
        app_name: deployment.app_name,
        container_id: deployment.container_id,
        db_name: deployment.db_name,
      });
      if (warnings.length) app.log.warn({ warnings }, `cleanup warnings for deployment ${deployment.id}`);

      await query('DELETE FROM deployments WHERE id = $1', [deployment.id]);
      return { ok: true, warnings: warnings.length ? warnings : undefined };
    },
  );

  // WebSocket /deploy/:id/logs/stream — live log streaming
  app.get<{ Params: { id: string } }>(
    '/deploy/:id/logs/stream',
    { websocket: true, preHandler: authenticate },
    async (socket, request) => {
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment?.container_id) {
        socket.close(1008, 'No container running');
        return;
      }
      streamLogs(deployment.container_id, socket);
    },
  );

  // POST /deploy/:id/redeploy — restart container
  app.post<{ Params: { id: string } }>(
    '/deploy/:id/redeploy',
    { preHandler: authenticate },
    async (request, reply) => {
      // 10 restarts per minute per user — prevents abuse of Docker API calls.
      if (!checkUserRateLimit(request.user.id, 'redeploy', 10, 60_000)) {
        return reply.code(429).send({ error: 'Rate limit exceeded. Try again in a minute.' });
      }
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      if (!deployment.container_id) {
        return reply.code(400).send({ error: 'No container to restart. Redeploy by uploading the project again.' });
      }

      // Restart existing container via the shared helper (which uses the
      // module-level Dockerode client in services/container.ts).
      try {
        await restartContainer(deployment.container_id);
        await query(
          `UPDATE deployments SET status = 'running', deploy_phase = NULL, updated_at = NOW() WHERE id = $1`,
          [deployment.id],
        );
      } catch (err: any) {
        request.log.warn({ err }, `restartContainer failed for ${deployment.container_id}`);
        return reply.code(500).send({ error: 'Failed to restart container' });
      }

      return {
        id: deployment.id,
        appName: deployment.app_name,
        subdomain: deployment.subdomain,
        url: appUrl(deployment.subdomain),
        status: 'running',
        projectType: deployment.project_type,
        tier: deployment.tier,
        port: deployment.port,
      };
    },
  );

  // WebSocket /deploy/:id/exec — interactive shell
  app.get<{ Params: { id: string } }>(
    '/deploy/:id/exec',
    { websocket: true, preHandler: authenticate },
    async (socket, request) => {
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment?.container_id) {
        socket.close(1008, 'No container running');
        return;
      }
      execInContainer(deployment.container_id, socket);
    },
  );

  // GET /deploy/group/:group — list all deployments in a group
  app.get<{ Params: { group: string } }>(
    '/deploy/group/:group',
    { preHandler: authenticate },
    async (request) => {
      const result = await query(
        `SELECT id, app_name, subdomain, status, project_type, tier, port, container_id,
                db_name, deploy_group, framework, deploy_phase, error_detail,
                detected_port, detected_database, created_at, updated_at
         FROM deployments WHERE user_id = $1 AND deploy_group = $2 ORDER BY app_name`,
        [request.user.id, request.params.group],
      );

      return {
        group: request.params.group,
        services: result.rows.map((row) => serializeDeploymentSummary(row)),
      };
    },
  );

  // DELETE /deploy/group/:group — delete all deployments in a group
  app.delete<{ Params: { group: string } }>(
    '/deploy/group/:group',
    { preHandler: authenticate },
    async (request) => {
      const result = await query(
        'SELECT * FROM deployments WHERE user_id = $1 AND deploy_group = $2',
        [request.user.id, request.params.group],
      );

      // Run the full cleanup for each deployment in the group. Image tag +
      // per-user network are deferred until the last row so we don't flap the
      // network; removeNetworkIfEmpty runs once at the end.
      const allWarnings: string[] = [];
      for (const deployment of result.rows) {
        const { warnings } = await cleanupDeployment(
          {
            user_id: request.user.id,
            app_name: deployment.app_name,
            container_id: deployment.container_id,
            db_name: deployment.db_name,
          },
          { cleanNetwork: false },
        );
        if (warnings.length) allWarnings.push(...warnings);
      }
      // One network-cleanup pass at the end for the whole group
      try {
        const { warnings } = await cleanupDeployment(
          { user_id: request.user.id, app_name: '', container_id: null, db_name: null },
          { removeImageTag: false, cleanNetwork: true },
        );
        if (warnings.length) allWarnings.push(...warnings);
      } catch { /* swallow — group delete is best-effort */ }

      await query(
        'DELETE FROM deployments WHERE user_id = $1 AND deploy_group = $2',
        [request.user.id, request.params.group],
      );

      if (allWarnings.length) app.log.warn({ warnings: allWarnings }, `cleanup warnings for group ${request.params.group}`);

      return { ok: true, deleted: result.rows.length, warnings: allWarnings.length ? allWarnings : undefined };
    },
  );
}

function fieldValue(field: any): string | undefined {
  if (!field) return undefined;
  if (typeof field === 'string') return field;
  if (field.value) return field.value;
  return undefined;
}

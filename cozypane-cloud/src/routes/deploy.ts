import type { FastifyInstance } from 'fastify';
import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join, normalize, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-fs';
import { query } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';
import { detectProject } from '../services/detector.js';
import { buildImage } from '../services/builder.js';
import {
  runContainer,
  stopContainer,
  getContainerLogs,
  streamLogs,
  execInContainer,
} from '../services/container.js';
import { provisionDatabase, dropDatabase } from '../services/database.js';

const APP_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export async function deployRoutes(app: FastifyInstance): Promise<void> {
  // POST /deploy — create or redeploy (async: returns immediately, build runs in background)
  app.post('/deploy', {
    preHandler: authenticate,
    config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req: any) => req.user?.id?.toString() || req.ip } },
  }, async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: 'Multipart upload with tar file required' });
    }

    // Extract fields from multipart
    const fields = data.fields as Record<string, any>;
    const appName = fieldValue(fields.appName);
    const tier = fieldValue(fields.tier) || 'small';
    const portOverride = fieldValue(fields.port);
    const needsDatabase = fieldValue(fields.needsDatabase);
    const envJson = fieldValue(fields.env);
    const deployGroup = fieldValue(fields.group);

    if (!appName || !APP_NAME_REGEX.test(appName)) {
      return reply.code(400).send({
        error: 'Invalid app name. Use lowercase alphanumeric characters and hyphens (2-64 chars).',
      });
    }

    if (!['small', 'medium', 'large'].includes(tier)) {
      return reply.code(400).send({ error: 'Invalid tier. Must be small, medium, or large.' });
    }

    const userId = request.user.id;
    const username = request.user.username;
    const subdomain = `${appName}-${username}`;
    const domain = process.env.DOMAIN || 'cozypane.com';

    // Save uploaded tar to temp dir before doing anything else
    const tempId = randomBytes(8).toString('hex');
    const tempDir = join(tmpdir(), `cozypane-deploy-${tempId}`);
    const extractDir = join(tempDir, 'project');
    mkdirSync(extractDir, { recursive: true });

    // Save and extract the upload synchronously (must finish before we return)
    try {
      const tarPath = join(tempDir, 'upload.tar.gz');
      const writeStream = createWriteStream(tarPath);
      await pipeline(data.file, writeStream);

      await new Promise<void>((resolve, reject) => {
        const readStream = createReadStream(tarPath);
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
        readStream.pipe(gunzip).pipe(extract);
        extract.on('finish', resolve);
        extract.on('error', reject);
        gunzip.on('error', reject);
        readStream.on('error', reject);
      });
    } catch (err: any) {
      rmSync(tempDir, { recursive: true, force: true });
      return reply.code(400).send({ error: `Failed to process upload: ${err.message}` });
    }

    // Detect project type and validate before creating DB record
    const projectInfo = detectProject(extractDir);
    if (portOverride) {
      const parsed = parseInt(portOverride, 10);
      if (parsed > 0 && parsed <= 65535) projectInfo.port = parsed;
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

    // Upsert deployment record — status 'building'
    const result = await query(
      `INSERT INTO deployments (user_id, app_name, subdomain, status, project_type, tier, port, deploy_group)
       VALUES ($1, $2, $3, 'building', $4, $5, $6, $7)
       ON CONFLICT (user_id, app_name) DO UPDATE SET
         status = 'building',
         project_type = EXCLUDED.project_type,
         tier = EXCLUDED.tier,
         port = EXCLUDED.port,
         deploy_group = EXCLUDED.deploy_group,
         build_log = NULL,
         updated_at = NOW()
       RETURNING id`,
      [userId, appName, subdomain, projectInfo.type, tier, projectInfo.port, deployGroup || null],
    );
    const deploymentId = result.rows[0].id;

    // Fire-and-forget background build — response is sent immediately
    buildAndDeploy({
      deploymentId,
      extractDir,
      tempDir,
      projectInfo,
      appName,
      subdomain,
      tier,
      userId,
      needsDatabase,
      envJson,
      log: app.log,
    }).catch(() => {}); // errors are handled inside

    return {
      id: deploymentId,
      subdomain,
      url: `https://${subdomain}.${domain}`,
      status: 'building',
      projectType: projectInfo.type,
      port: projectInfo.port,
      ...(projectInfo.warnings.length > 0 ? { warnings: projectInfo.warnings } : {}),
    };
  });

  // GET /deploy/list — user's deployments
  app.get('/deploy/list', { preHandler: authenticate }, async (request) => {
    const result = await query(
      `SELECT id, app_name, subdomain, status, project_type, tier, port, db_name, deploy_group, created_at, updated_at
       FROM deployments WHERE user_id = $1 ORDER BY deploy_group NULLS LAST, updated_at DESC`,
      [request.user.id],
    );

    const domain = process.env.DOMAIN || 'cozypane.com';
    return result.rows.map((row) => ({
      id: row.id,
      appName: row.app_name,
      subdomain: row.subdomain,
      url: `https://${row.subdomain}.${domain}`,
      status: row.status,
      projectType: row.project_type,
      tier: row.tier,
      port: row.port,
      hasDatabase: !!row.db_name,
      group: row.deploy_group || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
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

      const row = result.rows[0];
      const domain = process.env.DOMAIN || 'cozypane.com';
      return {
        id: row.id,
        appName: row.app_name,
        subdomain: row.subdomain,
        url: `https://${row.subdomain}.${domain}`,
        status: row.status,
        projectType: row.project_type,
        tier: row.tier,
        port: row.port,
        customDomains: row.custom_domains || [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
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

      if (deployment.container_id) {
        await stopContainer(deployment.container_id).catch(() => {});
      }

      // Drop provisioned database if one exists
      if (deployment.db_name) {
        await dropDatabase(request.user.id, deployment.app_name).catch((err: any) => {
          app.log.warn(`Failed to drop database ${deployment.db_name}: ${err.message}`);
        });
      }

      await query('DELETE FROM deployments WHERE id = $1', [deployment.id]);
      return { ok: true };
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
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      if (!deployment.container_id) {
        return reply.code(400).send({ error: 'No container to restart. Redeploy by uploading the project again.' });
      }

      // Restart existing container
      const Docker = (await import('dockerode')).default;
      const docker = new Docker({ socketPath: '/var/run/docker.sock' });
      try {
        const container = docker.getContainer(deployment.container_id);
        await container.restart({ t: 10 });
        await query(
          `UPDATE deployments SET status = 'running', updated_at = NOW() WHERE id = $1`,
          [deployment.id],
        );
      } catch {
        return reply.code(500).send({ error: 'Failed to restart container' });
      }

      const domain = process.env.DOMAIN || 'cozypane.com';
      return {
        id: deployment.id,
        appName: deployment.app_name,
        subdomain: deployment.subdomain,
        url: `https://${deployment.subdomain}.${domain}`,
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
        `SELECT id, app_name, subdomain, status, project_type, tier, port, db_name, deploy_group, created_at, updated_at
         FROM deployments WHERE user_id = $1 AND deploy_group = $2 ORDER BY app_name`,
        [request.user.id, request.params.group],
      );

      const domain = process.env.DOMAIN || 'cozypane.com';
      return {
        group: request.params.group,
        services: result.rows.map((row) => ({
          id: row.id,
          appName: row.app_name,
          subdomain: row.subdomain,
          url: `https://${row.subdomain}.${domain}`,
          status: row.status,
          projectType: row.project_type,
          tier: row.tier,
          port: row.port,
          hasDatabase: !!row.db_name,
        })),
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

      for (const deployment of result.rows) {
        if (deployment.container_id) {
          await stopContainer(deployment.container_id).catch(() => {});
        }
        if (deployment.db_name) {
          await dropDatabase(request.user.id, deployment.app_name).catch(() => {});
        }
      }

      await query(
        'DELETE FROM deployments WHERE user_id = $1 AND deploy_group = $2',
        [request.user.id, request.params.group],
      );

      return { ok: true, deleted: result.rows.length };
    },
  );
}

async function buildAndDeploy(params: {
  deploymentId: number;
  extractDir: string;
  tempDir: string;
  projectInfo: ReturnType<typeof detectProject>;
  appName: string;
  subdomain: string;
  tier: string;
  userId: number;
  needsDatabase: string | undefined;
  envJson: string | undefined;
  log: any;
}): Promise<void> {
  const { deploymentId, extractDir, tempDir, projectInfo, appName, subdomain, tier, userId, needsDatabase, envJson, log } = params;
  let newContainerId: string | undefined;

  try {
    // Stop old container if redeploying
    const existing = await query(
      'SELECT container_id FROM deployments WHERE id = $1 AND container_id IS NOT NULL',
      [deploymentId],
    );
    if (existing.rows.length > 0 && existing.rows[0].container_id) {
      await stopContainer(existing.rows[0].container_id).catch(() => {});
    }

    // Build Docker image
    const { tag: imageTag, buildLog } = await buildImage(extractDir, projectInfo, appName, userId);

    // Store build log (last 50KB to avoid bloating DB)
    const trimmedLog = buildLog.length > 50000 ? '...' + buildLog.slice(-50000) : buildLog;
    await query(`UPDATE deployments SET build_log = $1 WHERE id = $2`, [trimmedLog, deploymentId]).catch(() => {});

    // Build env vars
    const env: Record<string, string> = {};
    if (envJson) {
      try {
        const parsed = JSON.parse(envJson);
        if (typeof parsed === 'object' && parsed !== null) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') env[k] = v;
          }
        }
      } catch { /* ignore */ }
    }

    // Provision database if requested
    if (needsDatabase === 'postgres') {
      const db = await provisionDatabase(userId, appName);
      env.DATABASE_URL = db.connectionString;
      await query(
        `UPDATE deployments SET db_name = $1, db_user = $2, db_host = $3 WHERE id = $4`,
        [db.name, db.user, db.host, deploymentId],
      );
    }

    // Run container
    newContainerId = await runContainer(imageTag, { id: deploymentId, appName, subdomain, port: projectInfo.port, tier, env }, userId);

    await query(
      `UPDATE deployments SET container_id = $1, status = 'running', updated_at = NOW() WHERE id = $2`,
      [newContainerId, deploymentId],
    );
  } catch (err: any) {
    if (newContainerId) await stopContainer(newContainerId).catch(() => {});
    await query(
      `UPDATE deployments SET status = 'failed', build_log = COALESCE(build_log, '') || $1, updated_at = NOW() WHERE id = $2`,
      [`\n\nBUILD ERROR: ${err.message}`, deploymentId],
    ).catch(() => {});
    log.error(err, `Background build failed for deployment ${deploymentId}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function getDeployment(id: string, userId: number) {
  const result = await query(
    'SELECT * FROM deployments WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return result.rows[0] || null;
}

function fieldValue(field: any): string | undefined {
  if (!field) return undefined;
  if (typeof field === 'string') return field;
  if (field.value) return field.value;
  return undefined;
}

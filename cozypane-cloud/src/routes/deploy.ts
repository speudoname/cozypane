import type { FastifyInstance } from 'fastify';
import { createReadStream, createWriteStream, mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, normalize, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-fs';
import { query } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';
import { analyzeProject } from '../services/detector.js';
import { buildImage } from '../services/builder.js';
import {
  runContainer,
  stopContainer,
  getContainerLogs,
  streamLogs,
  execInContainer,
  ensureNetwork,
  waitForHealthy,
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

    // Fire-and-forget background build — response is sent immediately
    buildAndDeploy({
      deploymentId,
      extractDir,
      tempDir,
      analysis,
      appName,
      subdomain,
      tier,
      userId,
      envJson,
      log: app.log,
    }).catch(() => {}); // errors are handled inside

    return {
      id: deploymentId,
      subdomain,
      url: `https://${subdomain}.${domain}`,
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

  // GET /deploy/list — user's deployments
  app.get('/deploy/list', { preHandler: authenticate }, async (request) => {
    const result = await query(
      `SELECT id, app_name, subdomain, status, project_type, tier, port, db_name, deploy_group,
              framework, deploy_phase, error_detail, detected_port, detected_database,
              created_at, updated_at
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
      framework: row.framework || null,
      phase: row.deploy_phase || null,
      detectedPort: row.detected_port || null,
      detectedDatabase: row.detected_database || false,
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

      // Parse error_detail if it's JSON
      let errorDetail = null;
      if (row.error_detail) {
        try { errorDetail = JSON.parse(row.error_detail); } catch { errorDetail = row.error_detail; }
      }

      return {
        id: row.id,
        appName: row.app_name,
        subdomain: row.subdomain,
        url: `https://${row.subdomain}.${domain}`,
        status: row.status,
        phase: row.deploy_phase || null,
        framework: row.framework || null,
        detectedPort: row.detected_port || null,
        detectedDatabase: row.detected_database || false,
        recommendedTier: row.tier,
        errorDetail,
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
          `UPDATE deployments SET status = 'running', deploy_phase = NULL, updated_at = NOW() WHERE id = $1`,
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

  // --- Custom domain management ---

  // POST /deploy/:id/domains — add a custom domain
  app.post<{ Params: { id: string }; Body: { domain: string } }>(
    '/deploy/:id/domains',
    { preHandler: authenticate },
    async (request, reply) => {
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      const domainName = ((request.body as any)?.domain || '').trim().toLowerCase();
      if (!domainName || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domainName)) {
        return reply.code(400).send({ error: 'Invalid domain name' });
      }

      // Check domain isn't already taken
      const existing = await query('SELECT id FROM domains WHERE domain = $1', [domainName]);
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'Domain already in use' });
      }

      const result = await query(
        'INSERT INTO domains (deployment_id, domain) VALUES ($1, $2) RETURNING id, domain, verified, created_at',
        [deployment.id, domainName],
      );

      const row = result.rows[0];
      const cname = `${deployment.subdomain}.${process.env.DOMAIN || 'cozypane.com'}`;

      return {
        id: row.id,
        domain: row.domain,
        verified: row.verified,
        dnsInstructions: {
          type: 'CNAME',
          name: domainName,
          value: cname,
          message: `Add a CNAME record pointing "${domainName}" to "${cname}". Then click Verify.`,
        },
      };
    },
  );

  // POST /deploy/:id/domains/:domainId/verify — verify DNS and activate
  app.post<{ Params: { id: string; domainId: string } }>(
    '/deploy/:id/domains/:domainId/verify',
    { preHandler: authenticate },
    async (request, reply) => {
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      const domainResult = await query(
        'SELECT * FROM domains WHERE id = $1 AND deployment_id = $2',
        [request.params.domainId, deployment.id],
      );
      if (domainResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Domain not found' });
      }

      const domainRow = domainResult.rows[0];
      const expectedCname = `${deployment.subdomain}.${process.env.DOMAIN || 'cozypane.com'}`;

      // DNS lookup — check CNAME or A record
      // Apex domains (e.g. example.com) can't have true CNAMEs — providers like
      // Cloudflare flatten them to A records. So we check both:
      // 1. CNAME pointing to our subdomain
      // 2. A records matching our server's IP (domain resolves to us)
      let verified = false;
      let dnsError: string | null = null;
      try {
        const dns = await import('node:dns/promises');

        // Try CNAME first
        try {
          const cnameRecords = await dns.resolve(domainRow.domain, 'CNAME');
          verified = cnameRecords.some((r: string) =>
            r.toLowerCase().replace(/\.$/, '') === expectedCname.toLowerCase()
          );
        } catch {
          // No CNAME — try A record comparison (for apex/flattened domains)
        }

        if (!verified) {
          try {
            // Resolve both the custom domain and our target to IPs and compare
            const [customIps, targetIps] = await Promise.all([
              dns.resolve(domainRow.domain, 'A').catch(() => [] as string[]),
              dns.resolve(expectedCname, 'A').catch(() => [] as string[]),
            ]);
            if (customIps.length > 0 && targetIps.length > 0) {
              // Direct IP match
              verified = customIps.some((ip: string) => targetIps.includes(ip));
            }

            // If IPs don't match, the domain might be behind a CDN/proxy (e.g. Cloudflare).
            // Try an HTTP request — if the domain serves our app, it's configured correctly.
            if (!verified && customIps.length > 0) {
              try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 5000);
                const resp = await fetch(`http://${domainRow.domain}/`, {
                  signal: controller.signal,
                  redirect: 'manual',
                  headers: { 'Host': domainRow.domain },
                });
                clearTimeout(timeout);
                // If we get any response and the server header or response comes from our infra, consider verified
                // Any non-connection-refused response means the domain points somewhere that serves HTTP
                verified = true;
              } catch {
                // Connection failed — domain doesn't resolve to a working server
              }
            }

            if (!verified && customIps.length === 0) {
              dnsError = 'No DNS records found. DNS changes can take a few minutes to propagate.';
            } else if (!verified) {
              dnsError = `Domain resolves but could not reach the server. Check your DNS configuration.`;
            }
          } catch {
            dnsError = 'DNS lookup failed. Try again in a few minutes.';
          }
        }
      } catch (err: any) {
        dnsError = `DNS lookup failed: ${err.message}`;
      }

      if (verified) {
        // Mark verified
        await query('UPDATE domains SET verified = TRUE WHERE id = $1', [domainRow.id]);

        // Write Traefik file provider config — no container restart needed.
        // Traefik watches the dynamic config directory and picks up changes automatically.
        writeCustomDomainConfig(deployment.subdomain, domainRow.domain, deployment.port);
      }

      return {
        id: domainRow.id,
        domain: domainRow.domain,
        verified,
        error: dnsError,
      };
    },
  );

  // DELETE /deploy/:id/domains/:domainId — remove a custom domain
  app.delete<{ Params: { id: string; domainId: string } }>(
    '/deploy/:id/domains/:domainId',
    { preHandler: authenticate },
    async (request, reply) => {
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      const result = await query(
        'DELETE FROM domains WHERE id = $1 AND deployment_id = $2 RETURNING domain',
        [request.params.domainId, deployment.id],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Domain not found' });
      }

      // Remove Traefik file provider config
      removeCustomDomainConfig(result.rows[0].domain);

      return { ok: true, domain: result.rows[0].domain };
    },
  );

  // GET /deploy/:id/domains — list domains for a deployment
  app.get<{ Params: { id: string } }>(
    '/deploy/:id/domains',
    { preHandler: authenticate },
    async (request, reply) => {
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      const result = await query(
        'SELECT id, domain, verified, created_at FROM domains WHERE deployment_id = $1 ORDER BY created_at',
        [deployment.id],
      );

      const cname = `${deployment.subdomain}.${process.env.DOMAIN || 'cozypane.com'}`;
      return {
        domains: result.rows.map((r: any) => ({
          id: r.id,
          domain: r.domain,
          verified: r.verified,
          createdAt: r.created_at,
          cname,
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

async function updatePhase(deploymentId: number, phase: string): Promise<void> {
  await query(
    `UPDATE deployments SET deploy_phase = $1, updated_at = NOW() WHERE id = $2`,
    [phase, deploymentId],
  ).catch(() => {});
}

function sanitizeErrorMessage(msg: string): string {
  // Strip internal infrastructure details from error messages shown to users
  return msg
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[internal-ip]')  // IPs
    .replace(/\b[0-9a-f]{64}\b/g, '[container-id]')                          // Full container IDs
    .replace(/\b[0-9a-f]{12}\b/g, '[container-id]')                          // Short container IDs
    .replace(/postgresql:\/\/[^@]+@[^/]+\/\S+/g, 'postgresql://[redacted]')   // Connection strings
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[redacted]');               // Passwords
}

function makeErrorDetail(phase: string, code: string, message: string, suggestion: string, logs?: string): string {
  return JSON.stringify({
    phase,
    code,
    message: sanitizeErrorMessage(message),
    suggestion,
    ...(logs ? { logs: sanitizeErrorMessage(logs.slice(-2000)) } : {}),
  });
}

// --- Traefik file provider for custom domains ---
// Writes/removes YAML configs in the shared volume. Traefik watches and auto-reloads.
// No container restart needed.

const TRAEFIK_DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR || '/traefik-dynamic';

function customDomainConfigPath(domain: string): string {
  const safe = domain.replace(/[^a-z0-9.-]/g, '-');
  return join(TRAEFIK_DYNAMIC_DIR, `custom-${safe}.yml`);
}

function writeCustomDomainConfig(subdomain: string, domain: string, port: number): void {
  const routerName = `cp-${subdomain}`;
  const safeDomain = domain.replace(/\./g, '-');
  const customRouter = `cp-custom-${safeDomain}`;

  // The service is defined by Docker labels on the container (Docker provider).
  // File provider routers can reference Docker provider services via @docker suffix.
  const yaml = `http:
  routers:
    ${customRouter}:
      rule: "Host(\`${domain}\`)"
      entrypoints:
        - websecure
      tls:
        certResolver: cloudflare
      service: ${routerName}@docker
`;

  try {
    mkdirSync(TRAEFIK_DYNAMIC_DIR, { recursive: true });
    writeFileSync(customDomainConfigPath(domain), yaml);
    console.log(`Wrote Traefik config for custom domain: ${domain}`);
  } catch (err: any) {
    console.warn(`Failed to write Traefik config for ${domain}: ${err.message}`);
  }
}

function removeCustomDomainConfig(domain: string): void {
  try {
    const filePath = customDomainConfigPath(domain);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      console.log(`Removed Traefik config for custom domain: ${domain}`);
    }
  } catch (err: any) {
    console.warn(`Failed to remove Traefik config for ${domain}: ${err.message}`);
  }
}

function classifyBuildError(err: any, buildLog: string): { code: string; message: string; suggestion: string } {
  const errMsg = err?.message || String(err);

  // OOM kill (exit 137)
  if (errMsg.includes('137') || errMsg.includes('killed') || errMsg.includes('OOM')) {
    return {
      code: 'OOM',
      message: 'Build killed: out of memory',
      suggestion: 'The project may be too large for the current tier. Try tier: large.',
    };
  }

  // npm/yarn install failures
  if (buildLog.includes('npm ERR!') || buildLog.includes('npm error')) {
    return {
      code: 'INSTALL_FAILED',
      message: 'Package installation failed',
      suggestion: 'Check that package.json and lock files are valid. Look at build logs for details.',
    };
  }

  if (errMsg.includes('timed out')) {
    return {
      code: 'TIMEOUT',
      message: 'Build timed out after 10 minutes',
      suggestion: 'The build is taking too long. Try simplifying the build or using a larger tier.',
    };
  }

  return {
    code: 'BUILD_FAILED',
    message: errMsg,
    suggestion: 'Check build logs with cozypane_get_logs (type="build") for details.',
  };
}

async function buildAndDeploy(params: {
  deploymentId: number;
  extractDir: string;
  tempDir: string;
  analysis: ReturnType<typeof analyzeProject>;
  appName: string;
  subdomain: string;
  tier: string;
  userId: number;
  envJson: string | undefined;
  log: any;
}): Promise<void> {
  const { deploymentId, extractDir, tempDir, analysis, appName, subdomain, tier, userId, envJson, log } = params;
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

    // Phase: building
    await updatePhase(deploymentId, 'building');
    let buildLog = '';
    let imageTag: string;
    try {
      const result = await buildImage(extractDir, analysis, appName, userId);
      imageTag = result.tag;
      buildLog = result.buildLog;
    } catch (err: any) {
      // buildImage attaches partial log to the error object
      buildLog = err.buildLog || buildLog;
      const errInfo = classifyBuildError(err, buildLog);
      const errorDetail = makeErrorDetail('build', errInfo.code, errInfo.message, errInfo.suggestion, buildLog);
      await query(
        `UPDATE deployments SET status = 'failed', deploy_phase = 'build', error_detail = $1, build_log = $2, updated_at = NOW() WHERE id = $3`,
        [errorDetail, buildLog.slice(-50000), deploymentId],
      ).catch(() => {});
      throw err;
    }

    // Store build log
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

    // Phase: provisioning_db (if needed)
    if (analysis.needsDatabase) {
      await updatePhase(deploymentId, 'provisioning_db');
      try {
        const db = await provisionDatabase(userId, appName);
        env.DATABASE_URL = db.connectionString;
        await query(
          `UPDATE deployments SET db_name = $1, db_user = $2, db_host = $3 WHERE id = $4`,
          [db.name, db.user, db.host, deploymentId],
        );
      } catch (err: any) {
        const errorDetail = makeErrorDetail('provisioning_db', 'DB_PROVISION_FAILED', err.message || 'Database provisioning failed', 'Platform failed to create database. Try redeploying or contact support.');
        await query(
          `UPDATE deployments SET status = 'failed', deploy_phase = 'provisioning_db', error_detail = $1, updated_at = NOW() WHERE id = $2`,
          [errorDetail, deploymentId],
        ).catch(() => {});
        throw err;
      }
    }

    // Phase: starting
    await updatePhase(deploymentId, 'starting');
    newContainerId = await runContainer(
      imageTag,
      { id: deploymentId, appName, subdomain, port: analysis.port, tier, env },
      userId,
    );

    await query(
      `UPDATE deployments SET container_id = $1 WHERE id = $2`,
      [newContainerId, deploymentId],
    ).catch(() => {});

    // Phase: health_check
    await updatePhase(deploymentId, 'health_check');
    const health = await waitForHealthy(newContainerId, analysis.port, 120000);

    if (health.healthy) {
      await query(
        `UPDATE deployments SET status = 'running', deploy_phase = NULL, updated_at = NOW() WHERE id = $1`,
        [deploymentId],
      );

      // Regenerate Traefik file provider configs for any verified custom domains.
      // On redeploy the container is recreated — the Docker service name stays the same
      // but Traefik needs the file configs to exist for custom domain routing.
      try {
        const domainRows = await query(
          'SELECT domain FROM domains WHERE deployment_id = (SELECT id FROM deployments WHERE user_id = $1 AND app_name = $2) AND verified = TRUE',
          [userId, appName],
        );
        for (const row of domainRows.rows) {
          writeCustomDomainConfig(subdomain, (row as any).domain, analysis.port);
        }
      } catch { /* non-fatal */ }
    } else {
      // Check if container crashed within first few seconds
      const errorCode = health.error?.includes('exited') ? 'APP_CRASH' : 'UNHEALTHY';
      const suggestion = errorCode === 'APP_CRASH'
        ? 'The app crashed on startup. Check runtime logs with cozypane_get_logs for errors.'
        : 'The server started but is not responding to HTTP requests. Verify it listens on the correct port.';
      const errorDetail = makeErrorDetail('health_check', errorCode, health.error || 'Health check failed', suggestion, health.logs);

      await query(
        `UPDATE deployments SET status = 'unhealthy', deploy_phase = 'health_check', error_detail = $1, updated_at = NOW() WHERE id = $2`,
        [errorDetail, deploymentId],
      );

      // For non-crash cases, schedule a delayed re-check — the server may come up
      // after migrations or slow startup. Don't block the response.
      if (errorCode === 'UNHEALTHY') {
        const reCheckId = newContainerId;
        const reCheckPort = analysis.port;
        const reCheckDeployId = deploymentId;
        setTimeout(async () => {
          try {
            const reCheck = await waitForHealthy(reCheckId, reCheckPort, 60000);
            if (reCheck.healthy) {
              await query(
                `UPDATE deployments SET status = 'running', deploy_phase = NULL, error_detail = NULL, updated_at = NOW() WHERE id = $1 AND status = 'unhealthy'`,
                [reCheckDeployId],
              );
            }
          } catch { /* non-fatal background check */ }
        }, 5000);
      }
    }
  } catch (err: any) {
    if (newContainerId) await stopContainer(newContainerId).catch(() => {});

    // Only update if not already set by phase-specific error handling above
    const current = await query('SELECT status FROM deployments WHERE id = $1', [deploymentId]).catch(() => null);
    if (current?.rows?.[0]?.status === 'building') {
      await query(
        `UPDATE deployments SET status = 'failed', build_log = COALESCE(build_log, '') || $1, updated_at = NOW() WHERE id = $2`,
        [`\n\nBUILD ERROR: ${err.message}`, deploymentId],
      ).catch(() => {});
    }
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

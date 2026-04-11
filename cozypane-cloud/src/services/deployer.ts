// Deployment orchestration — the `buildAndDeploy` fire-and-forget worker
// that takes an uploaded tarball through:
//   building → provisioning_db (optional) → starting → health_check → running
//
// Split out of routes/deploy.ts (audit H18). The route handler is now a
// thin HTTP shell that parses multipart, inserts the deployment row, and
// hands off to `buildAndDeploy()` via `.catch(() => {})` so the HTTP
// response returns immediately while the background worker continues.
//
// Error classification (OOM, INSTALL_FAILED, TIMEOUT, DOCKER_UNAVAILABLE,
// PORT_CONFLICT, STARTUP_FAILED, APP_CRASH, UNHEALTHY), sanitization, and
// the JSON error_detail shape all live in this file so the routes layer
// doesn't know the deployment state machine.

import { rmSync } from 'node:fs';
import { query } from '../db/index.js';
import { analyzeProject } from './detector.js';
import { buildImage } from './builder.js';
import {
  runContainer,
  stopContainer,
  waitForHealthy,
} from './container.js';
import { provisionDatabase } from './database.js';
import { writeCustomDomainConfig } from './traefik.js';

// Delayed health-re-check timers. Tracked so the shutdown sequence in
// index.ts can cancel them before closing the Postgres pools — an
// un-cancelled timer would fire against a closed pool and silently error.
const pendingRechecks = new Set<ReturnType<typeof setTimeout>>();

export function cancelPendingHealthRechecks(): void {
  for (const handle of pendingRechecks) {
    clearTimeout(handle);
  }
  pendingRechecks.clear();
}

// -------- Internal helpers --------

async function updatePhase(deploymentId: number, phase: string): Promise<void> {
  await query(
    `UPDATE deployments SET deploy_phase = $1, updated_at = NOW() WHERE id = $2`,
    [phase, deploymentId],
  ).catch(() => {});
}

export function sanitizeErrorMessage(msg: string): string {
  // Strip internal infrastructure details from error messages shown to users.
  return msg
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[internal-ip]')   // IPs
    .replace(/\b[0-9a-f]{64}\b/g, '[container-id]')                           // Full container IDs
    .replace(/\b[0-9a-f]{12}\b/g, '[container-id]')                           // Short container IDs
    .replace(/postgresql:\/\/[^@]+@[^/]+\/\S+/g, 'postgresql://[redacted]')   // Connection strings
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[redacted]');               // Passwords
}

export function makeErrorDetail(
  phase: string,
  code: string,
  message: string,
  suggestion: string,
  logs?: string,
): string {
  return JSON.stringify({
    phase,
    code,
    message: sanitizeErrorMessage(message),
    suggestion,
    ...(logs ? { logs: sanitizeErrorMessage(logs.slice(-2000)) } : {}),
  });
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

// -------- Main orchestrator --------

export interface BuildAndDeployParams {
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
}

export async function buildAndDeploy(params: BuildAndDeployParams): Promise<void> {
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

    // Build env vars from the user-supplied JSON blob
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
    try {
      newContainerId = await runContainer(
        imageTag,
        { id: deploymentId, appName, subdomain, port: analysis.port, tier, env },
        userId,
      );
    } catch (err: any) {
      // runContainer failures (ensureNetwork, image-pull, port conflict,
      // connectToNetwork) previously fell through to the outer catch which
      // set status=failed but left error_detail=null. Surface the failure
      // here so the UI can explain what happened.
      const msg = err?.message || 'Failed to start container';
      const code = /ENOENT|ECONNREFUSED|EACCES/.test(msg) ? 'DOCKER_UNAVAILABLE'
        : /port|address already in use/i.test(msg) ? 'PORT_CONFLICT'
        : 'STARTUP_FAILED';
      const suggestion = code === 'DOCKER_UNAVAILABLE'
        ? 'Docker daemon is unreachable on the platform. Contact support.'
        : code === 'PORT_CONFLICT'
        ? 'Another deployment is using the same port. Try redeploying.'
        : 'The container failed to start. Check build logs and runtime logs.';
      const errorDetail = makeErrorDetail('starting', code, msg, suggestion);
      await query(
        `UPDATE deployments SET status = 'failed', deploy_phase = 'starting', error_detail = $1, updated_at = NOW() WHERE id = $2`,
        [errorDetail, deploymentId],
      ).catch(() => {});
      throw err;
    }

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
      // On redeploy the container is recreated — the Docker service name stays
      // the same but Traefik needs the file configs to exist for custom domain
      // routing.
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

      // For non-crash cases, schedule a delayed re-check — the server may come
      // up after migrations or slow startup. Don't block the response. The
      // UPDATE is guarded by status='unhealthy' so it's a no-op if the user
      // deleted or redeployed in the meantime.
      if (errorCode === 'UNHEALTHY') {
        const reCheckId = newContainerId;
        const reCheckPort = analysis.port;
        const reCheckDeployId = deploymentId;
        const handle: ReturnType<typeof setTimeout> = setTimeout(async () => {
          pendingRechecks.delete(handle);
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
        pendingRechecks.add(handle);
      }
    }
  } catch (err: any) {
    if (newContainerId) await stopContainer(newContainerId).catch(() => {});

    // Only update if not already set by phase-specific error handling above.
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

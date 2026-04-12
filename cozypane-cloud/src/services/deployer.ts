// Deployment orchestration. Takes an uploaded tarball through:
//   building → provisioning_db (optional) → starting → health_check → running
//
// Error classification (OOM, INSTALL_FAILED, TIMEOUT, DOCKER_UNAVAILABLE,
// PORT_CONFLICT, STARTUP_FAILED, APP_CRASH, UNHEALTHY), sanitization, and
// the JSON error_detail shape all live here so the routes layer doesn't
// know the deployment state machine.

import { rmSync, existsSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import { analyzeProject } from './detector.js';
import { buildImage } from './builder.js';
import {
  runContainer,
  stopContainer,
  waitForHealthy,
} from './container.js';
import { provisionDatabase } from './database.js';
import { writeCustomDomainConfig } from './traefik.js';
import {
  markPhase, markPreFlightFailed, getExistingContainerId,
  markBuildFailed, updateBuildLog, updateDbInfo, markDbProvisionFailed,
  markStartFailed, updateContainerId, markRunning, getVerifiedDomains,
  markUnhealthy, markRunningFromUnhealthy, getDeploymentStatus, appendBuildError,
} from '../db/deploymentState.js';

// Delayed health-re-check timers. Tracked so the shutdown sequence in
// index.ts can cancel them before closing the Postgres pools — an
// un-cancelled timer would fire against a closed pool and silently error.
const pendingRechecks = new Set<ReturnType<typeof setTimeout>>();

// Env var names that could enable container-escape vectors via LD_PRELOAD
// or NODE_OPTIONS injection. Users can set these in their Dockerfile instead.
const DENIED_ENV_KEYS = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS',
  'PATH', 'HOME', 'HOSTNAME', 'USER',
  // Proxy vars — prevent routing container traffic through attacker-controlled proxies
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
  'ALL_PROXY', 'NO_PROXY', 'no_proxy',
  // TLS vars — prevent disabling certificate verification or injecting CA certs
  'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
]);

let log: FastifyBaseLogger = console as any;

export function setDeployerLogger(logger: FastifyBaseLogger): void {
  log = logger;
}

export function cancelPendingHealthRechecks(): void {
  for (const handle of pendingRechecks) {
    clearTimeout(handle);
  }
  pendingRechecks.clear();
}

// -------- Internal helpers --------

function sanitizeErrorMessage(msg: string): string {
  // Strip internal infrastructure details from error messages shown to users.
  return msg
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[internal-ip]')   // IPs
    .replace(/\b[0-9a-f]{64}\b/g, '[container-id]')                           // Full container IDs
    .replace(/\b[0-9a-f]{12}\b/g, '[container-id]')                           // Short container IDs
    .replace(/postgresql:\/\/[^@]+@[^/]+\/\S+/g, 'postgresql://[redacted]')   // Connection strings
    .replace(/password\s*[:=]\s*\S+/gi, 'password=[redacted]');               // Passwords
}

function makeErrorDetail(
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

  // Pre-flight: the extracted project must still exist. On a clean first
  // run it always does. It can vanish if the API container was recreated
  // between enqueue and worker pickup AND the old build data volume was
  // lost — now that BUILD_DATA_DIR lives on a named volume that case is
  // prevented, but stalled-job recovery can also resurrect jobs after an
  // arbitrary delay, so we still validate before handing off to Dockerode
  // (which would otherwise throw an uncaught-exception on its tar stream).
  if (!existsSync(extractDir)) {
    const errorDetail = makeErrorDetail(
      'pre_flight',
      'BUILD_DATA_LOST',
      `Build context missing at ${extractDir}`,
      'The build data volume was recreated or the upload extract directory was deleted. Please redeploy.',
    );
    await markPreFlightFailed(deploymentId, errorDetail).catch(() => {});
    log.error({ extractDir, deploymentId }, 'Build aborted: extractDir missing');
    return;
  }

  try {
    // Stop old container if redeploying
    const existingContainerId = await getExistingContainerId(deploymentId);
    if (existingContainerId) {
      await stopContainer(existingContainerId).catch(() => {});
    }

    // Phase: building
    await markPhase(deploymentId, 'building').catch((err) => {
      log.warn({ deploymentId, phase: 'building', err: err.message }, 'markPhase failed');
    });
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
      await markBuildFailed(deploymentId, errorDetail, buildLog).catch(() => {});
      throw err;
    }

    // Store build log
    const trimmedLog = buildLog.length > 50000 ? '...' + buildLog.slice(-50000) : buildLog;
    await updateBuildLog(deploymentId, trimmedLog).catch(() => {});

    // Build env vars from the user-supplied JSON blob.
    const env: Record<string, string> = {};
    if (envJson) {
      try {
        const parsed = JSON.parse(envJson);
        if (typeof parsed === 'object' && parsed !== null) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v !== 'string') continue;
            if (DENIED_ENV_KEYS.has(k)) {
              log.warn({ deploymentId, key: k }, 'Rejected dangerous env key');
              continue;
            }
            env[k] = v;
          }
        }
      } catch (e: any) {
        log.warn({ deploymentId, err: e.message }, 'Failed to parse env JSON');
      }
    }

    // Phase: provisioning_db (if needed)
    if (analysis.needsDatabase) {
      await markPhase(deploymentId, 'provisioning_db').catch((err) => {
        log.warn({ deploymentId, phase: 'provisioning_db', err: err.message }, 'markPhase failed');
      });
      try {
        const db = await provisionDatabase(userId, appName);
        env.DATABASE_URL = db.connectionString;
        await updateDbInfo(deploymentId, db.name, db.user, db.host);
      } catch (err: any) {
        const errorDetail = makeErrorDetail('provisioning_db', 'DB_PROVISION_FAILED', err.message || 'Database provisioning failed', 'Platform failed to create database. Try redeploying or contact support.');
        await markDbProvisionFailed(deploymentId, errorDetail).catch(() => {});
        throw err;
      }
    }

    // Phase: starting
    await markPhase(deploymentId, 'starting').catch((err) => {
      log.warn({ deploymentId, phase: 'starting', err: err.message }, 'markPhase failed');
    });
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
      await markStartFailed(deploymentId, errorDetail).catch(() => {});
      throw err;
    }

    await updateContainerId(deploymentId, newContainerId).catch(() => {});

    // Phase: health_check
    await markPhase(deploymentId, 'health_check').catch((err) => {
      log.warn({ deploymentId, phase: 'health_check', err: err.message }, 'markPhase failed');
    });
    const health = await waitForHealthy(newContainerId, analysis.port, 120000);

    if (health.healthy) {
      await markRunning(deploymentId);

      // Regenerate Traefik file provider configs for any verified custom domains.
      // On redeploy the container is recreated — the Docker service name stays
      // the same but Traefik needs the file configs to exist for custom domain
      // routing.
      try {
        const domainRows = await getVerifiedDomains(userId, appName);
        for (const row of domainRows) {
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

      await markUnhealthy(deploymentId, errorDetail);

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
              await markRunningFromUnhealthy(reCheckDeployId);
            }
          } catch { /* non-fatal background check */ }
        }, 5000);
        pendingRechecks.add(handle);
      }
    }
  } catch (err: any) {
    if (newContainerId) await stopContainer(newContainerId).catch(() => {});

    // Only update if not already set by phase-specific error handling above.
    const current = await getDeploymentStatus(deploymentId).catch(() => null);
    if (current?.status === 'building') {
      await appendBuildError(deploymentId, `\n\nBUILD ERROR: ${err.message}`).catch(() => {});
    }
    log.error(err, `Background build failed for deployment ${deploymentId}`);
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      log.warn({ tempDir, err: cleanupErr }, 'Failed to clean up build tempDir');
    }
  }
}

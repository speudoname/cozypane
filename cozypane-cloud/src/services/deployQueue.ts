// M23 — BullMQ-backed build queue for deployments.
//
// Prior to this module, `POST /deploy` called `buildAndDeploy(...)` as a
// fire-and-forget background task (`.catch(() => {})`). That worked at low
// scale but had no concurrency cap, no persistence, and no resumption after
// API crashes. Wave 1 shipped M25 (a 10-minute startup reconcile for stuck
// rows) as a safety net, but the audit (M23) asked for a real queue.
//
// This module provides:
//   - a `deployQueue` BullMQ Queue for producers (routes/deploy.ts)
//   - a `Worker` that consumes jobs and calls `buildAndDeploy(...)` from
//     `services/deployer.ts` unchanged
//   - a `drainAndClose()` helper for graceful shutdown in index.ts
//
// Architecture decision: the Worker runs *in-process* inside the same API
// container, not as a separate service. Rationale:
//   1. Jobs reference filesystem paths in the API container's /tmp
//      (extractDir, tempDir). A separate worker container would need a
//      shared volume or would have to re-upload.
//   2. Scale-up path: if the cloud ever needs to shard builds across
//      multiple machines, the extraction step can move to a shared
//      volume and the worker can be split out. For now, in-process is
//      simpler and has no cross-container data dependency.
//   3. BullMQ's stalled-job recovery catches the case where this process
//      crashes mid-build — the job is re-queued after `stalledInterval`
//      and another worker instance (or the same one after restart) picks
//      it up.
//
// No retries: build failures are deterministic (bad Dockerfile, app
// doesn't compile, etc.). Retrying would just run the same build twice
// with the same result and confuse the UI's phase reporting.

import { Queue, Worker, QueueEvents } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { buildAndDeploy, type BuildAndDeployParams } from './deployer.js';
import { query } from '../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { analyzeProject } from './detector.js';

const QUEUE_NAME = 'deploy-builds';

/**
 * Job payload for the deploy queue. Note: `analysis` is serialized as a
 * plain object (BullMQ uses JSON for storage), and `log` is reconstructed
 * by the worker from the Fastify instance's root logger.
 */
export interface DeployJobData {
  deploymentId: number;
  extractDir: string;
  tempDir: string;
  analysis: ReturnType<typeof analyzeProject>;
  appName: string;
  subdomain: string;
  tier: string;
  userId: number;
  envJson: string | undefined;
}

function getConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL || 'redis://redis:6379/0';
  // Parse the URL into the shape BullMQ expects. BullMQ also accepts a
  // connection string directly via `new Queue(name, { connection: url })`
  // in some versions, but the explicit object is more portable.
  const parsed = new URL(url);
  const port = parsed.port ? parseInt(parsed.port, 10) : 6379;
  const host = parsed.hostname || 'redis';
  const password = parsed.password || undefined;
  const db = parsed.pathname && parsed.pathname.length > 1
    ? parseInt(parsed.pathname.slice(1), 10)
    : 0;
  return {
    host,
    port,
    password,
    db: Number.isNaN(db) ? 0 : db,
    // BullMQ requires `maxRetriesPerRequest: null` on its Redis connection
    // because the worker uses long-polling BLPOP and can't have commands
    // auto-retried mid-poll. Setting anything else triggers a runtime
    // warning and BullMQ silently overrides to null anyway.
    maxRetriesPerRequest: null,
  };
}

// ---- Queue (producer side) ----

let _queue: Queue<DeployJobData> | null = null;

/** Lazy-initialized producer. Created on first `add` to avoid connecting at import. */
export function getDeployQueue(): Queue<DeployJobData> {
  if (_queue) return _queue;
  _queue = new Queue<DeployJobData>(QUEUE_NAME, {
    connection: getConnection(),
    defaultJobOptions: {
      // Build failures are deterministic; retrying is a waste of resources
      // AND confuses the UI since each attempt writes a fresh phase/log.
      attempts: 1,
      // Keep the last 100 terminal jobs around for debugging. Older jobs
      // are eligible for cleanup so Redis doesn't balloon over time.
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  });
  return _queue;
}

/**
 * Enqueue a new build. Called by `routes/deploy.ts` after inserting the
 * deployment row. Returns the BullMQ job id so the route handler can
 * include it in the response for debugging (not strictly required).
 */
export async function enqueueDeploy(data: DeployJobData): Promise<string> {
  const q = getDeployQueue();
  const job = await q.add('build', data, {
    // Use the deployment id as the BullMQ job id so duplicate enqueues
    // (e.g. from a retry) are idempotent. BullMQ will ignore the second
    // add() if a job with the same id already exists.
    jobId: `deploy-${data.deploymentId}`,
  });
  return job.id || `deploy-${data.deploymentId}`;
}

// ---- Worker (consumer side) ----

let _worker: Worker<DeployJobData> | null = null;
let _queueEvents: QueueEvents | null = null;

/**
 * Start the build worker. Called once from `index.ts` at process boot,
 * AFTER the Postgres pools are ready (the worker writes to `deployments`
 * via the deployer). Safe to call multiple times — second call is a no-op.
 */
export function startDeployWorker(log: FastifyBaseLogger): Worker<DeployJobData> {
  if (_worker) return _worker;

  const concurrency = Math.max(
    1,
    parseInt(process.env.DEPLOY_QUEUE_CONCURRENCY || '4', 10) || 4,
  );

  _worker = new Worker<DeployJobData>(
    QUEUE_NAME,
    async (job) => {
      const data = job.data;
      const childLog = log.child({ jobId: job.id, deploymentId: data.deploymentId });
      childLog.info(`Starting build for deployment ${data.deploymentId}`);

      const params: BuildAndDeployParams = {
        deploymentId: data.deploymentId,
        extractDir: data.extractDir,
        tempDir: data.tempDir,
        analysis: data.analysis,
        appName: data.appName,
        subdomain: data.subdomain,
        tier: data.tier,
        userId: data.userId,
        envJson: data.envJson,
        log: childLog,
      };

      await buildAndDeploy(params);
      childLog.info(`Build job completed for deployment ${data.deploymentId}`);
    },
    {
      connection: getConnection(),
      concurrency,
      // If a worker disappears mid-job (process crash), the job becomes
      // "stalled" and is re-queued after this interval. 30s is long
      // enough to avoid false positives from transient CPU stalls, short
      // enough that a real crash is recovered quickly.
      stalledInterval: 30_000,
      maxStalledCount: 1,
    },
  );

  _worker.on('failed', async (job, err) => {
    log.error({ jobId: job?.id, deploymentId: job?.data?.deploymentId, err }, 'Deploy job failed');
    // Safety net: if the deployment row is still in 'building' after the
    // job fails (e.g. the failure happened in the queue machinery itself,
    // not inside buildAndDeploy), mark it failed so the user isn't left
    // staring at a phantom build. buildAndDeploy's internal error
    // handling already covers the common case.
    if (job?.data?.deploymentId) {
      try {
        await query(
          `UPDATE deployments
             SET status = 'failed',
                 deploy_phase = COALESCE(deploy_phase, 'queue'),
                 error_detail = COALESCE(error_detail, $1),
                 updated_at = NOW()
           WHERE id = $2 AND status = 'building'`,
          [
            JSON.stringify({
              phase: 'queue',
              code: 'QUEUE_FAILURE',
              message: err?.message || 'Queue worker failure',
              suggestion: 'Try redeploying. If the problem persists, contact support.',
            }),
            job.data.deploymentId,
          ],
        );
      } catch (e) {
        log.error({ e }, 'Failed to mark deployment failed after queue error');
      }
    }
  });

  _worker.on('completed', (job) => {
    log.info({ jobId: job.id, deploymentId: job.data.deploymentId }, 'Deploy job completed');
  });

  _worker.on('error', (err) => {
    log.error({ err }, 'Deploy worker error');
  });

  // QueueEvents is a separate subscriber connection used for observability.
  // Optional for correctness but useful for future metrics.
  _queueEvents = new QueueEvents(QUEUE_NAME, { connection: getConnection() });

  log.info(`Deploy worker started (concurrency=${concurrency})`);
  return _worker;
}

export async function getQueueStats() {
  const q = getDeployQueue();
  const counts = await q.getJobCounts('active', 'waiting', 'completed', 'failed');
  return counts;
}

export async function getFailedJobs(limit = 50) {
  const q = getDeployQueue();
  const jobs = await q.getJobs('failed', 0, limit);
  return jobs.map(j => ({
    id: j.id,
    data: { deploymentId: j.data?.deploymentId, appName: j.data?.appName, subdomain: j.data?.subdomain, userId: j.data?.userId },
    failedReason: j.failedReason || 'Unknown',
    timestamp: j.timestamp,
    finishedOn: j.finishedOn,
  }));
}

/**
 * Graceful shutdown. Called from `index.ts` on SIGTERM/SIGINT before
 * closing the Postgres pools. Waits for in-flight jobs to finish (or up
 * to a timeout, after which BullMQ force-closes and the stalled-job
 * recovery in the next process will resume them).
 */
export async function drainAndClose(log: FastifyBaseLogger): Promise<void> {
  log.info('Draining deploy queue...');
  // Close the worker first: this lets any currently-running job finish
  // its `buildAndDeploy` call (up to the internal timeout of that
  // function). New jobs will not be picked up.
  try {
    if (_worker) {
      await _worker.close();
      log.info('Deploy worker closed');
    }
  } catch (err) {
    log.error({ err }, 'Error closing deploy worker');
  }
  try {
    if (_queueEvents) {
      await _queueEvents.close();
    }
  } catch (err) {
    log.error({ err }, 'Error closing queue events');
  }
  // Close the Queue last — it only produces, so after the worker is down
  // there's nothing left to do.
  try {
    if (_queue) {
      await _queue.close();
      log.info('Deploy queue closed');
    }
  } catch (err) {
    log.error({ err }, 'Error closing deploy queue');
  }
  _worker = null;
  _queueEvents = null;
  _queue = null;
}

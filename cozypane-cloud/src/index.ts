import 'dotenv/config';
import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, platformPool, initDb } from './db/index.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { deployRoutes } from './routes/deploy.js';
import { domainRoutes } from './routes/domains.js';
import { adminRoutes } from './routes/admin.js';
import { startDeployWorker, drainAndClose as drainDeployQueue } from './services/deployQueue.js';
import { cancelPendingHealthRechecks, setDeployerLogger } from './services/deployer.js';
import { cleanupOrphanBuildDirs } from './services/buildCleanup.js';
import { startPeriodicImagePrune, stopPeriodicImagePrune } from './services/imagePrune.js';
import { setContainerLogger } from './services/container.js';
import { setDatabaseLogger } from './services/database.js';
import { setTraefikLogger } from './services/traefik.js';
import { DOMAIN } from './services/serializers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV !== 'production';

const app = Fastify({
  logger: isDev
    ? {
        level: 'info',
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : { level: 'info' },
});

// Plugins
const allowedOrigins = isDev
  ? [/localhost/]
  : [
      `https://admin.${DOMAIN}`,
      `https://${DOMAIN}`,
      `https://www.${DOMAIN}`,
    ];
await app.register(cors, {
  origin: allowedOrigins,
  credentials: true,
});

// Cookie plugin — used by /auth/admin-callback to set an HttpOnly
// admin_session cookie instead of redirecting with the JWT in the URL
// fragment (which survives in browser history + was readable by any
// future script on the admin page).
await app.register(cookie, {
  secret: process.env.JWT_SECRET, // used only for signed cookies (not used today but harmless)
});

await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

await app.register(multipart, {
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  },
});

await app.register(websocket);

// Database connection with retry
async function connectDb(retries = 5, delay = 3000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      app.log.info('Connected to PostgreSQL');
      await initDb();
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      app.log.warn(`Database not ready, retrying in ${delay / 1000}s... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

await connectDb();

// Initialize service loggers so they use pino (structured JSON in prod)
// instead of console.log. Must run after Fastify is created.
setContainerLogger(app.log);
setDatabaseLogger(app.log);
setDeployerLogger(app.log);
setTraefikLogger(app.log);

// Reconcile stuck 'building' deployments from a previous run. If the API
// process crashes mid-build (or the host is restarted), rows can be left in
// status='building' forever because buildAndDeploy runs as a fire-and-forget
// background task with no persistent queue. Any row that still claims to be
// building but has no container_id and wasn't touched recently is clearly
// orphaned from a prior process and should be marked failed so the user can
// redeploy.
try {
  const reconciled = await pool.query(
    `UPDATE deployments
       SET status = 'failed',
           deploy_phase = 'interrupted',
           error_detail = '{"phase":"interrupted","code":"SERVER_RESTART","message":"Build was interrupted by a server restart. Redeploy to try again."}',
           updated_at = NOW()
     WHERE status = 'building'
       AND container_id IS NULL
       AND updated_at < NOW() - INTERVAL '10 minutes'
     RETURNING id`,
  );
  if (reconciled.rowCount && reconciled.rowCount > 0) {
    app.log.warn(`Reconciled ${reconciled.rowCount} stuck 'building' deployments from prior run`);
  }
} catch (err) {
  app.log.error({ err }, 'Failed to reconcile stuck deployments on startup');
}

// Admin SPA static files
await app.register(fastifyStatic, {
  root: join(__dirname, 'admin', 'public'),
  prefix: '/admin/',
  decorateReply: false,
});

// Central error handler — runs for any thrown / rejected error in a route.
// Keeps the response shape consistent (`{ error }`) and hides internal details
// (Postgres error messages, stack traces, file paths) for 5xx errors. Routes
// that explicitly `reply.code(400).send({ error: '...' })` are unaffected.
app.setErrorHandler((err: FastifyError, request, reply) => {
  const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 500
    ? err.statusCode
    : 500;
  if (statusCode >= 500) {
    request.log.error({ err, url: request.url }, 'request error');
    reply.code(500).send({ error: 'Internal server error' });
  } else {
    // Client errors (validation, not found, unauthorized) — surface the
    // message verbatim so the client can show it.
    reply.code(statusCode).send({ error: err.message || 'Request error' });
  }
});

// Routes
//
// M14 — API routes are also mounted under `/v1/` as an alias so future
// breaking changes can ship as `/v2/` without disturbing existing clients.
// Existing `/auth/...`, `/deploy/...`, `/admin/...` URLs keep working for
// backwards compatibility with deployed desktop apps and the admin SPA.
await app.register(healthRoutes);
await app.register(authRoutes);
await app.register(deployRoutes);
await app.register(domainRoutes);
await app.register(adminRoutes);
await app.register(authRoutes, { prefix: '/v1' });
await app.register(deployRoutes, { prefix: '/v1' });
await app.register(domainRoutes, { prefix: '/v1' });
await app.register(adminRoutes, { prefix: '/v1' });

// Start server
const port = parseInt(process.env.PORT || '3000', 10);

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`CozyPane Cloud API listening on :${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Sweep orphan build data directories left over from previous process
// lifetimes. Runs alongside the DB reconcile above — rows are marked
// failed, directories are removed. Order matters: the sweep is SAFE to
// run before the worker starts because the worker's stalled-job recovery
// won't touch disk until its first job.
cleanupOrphanBuildDirs(app.log);

// M23 — start the deploy queue worker after the HTTP listener is up so
// the Postgres pools are definitely ready by the time the worker starts
// claiming jobs. Runs in-process; see services/deployQueue.ts for why.
startDeployWorker(app.log);

// Periodic Docker image + build-cache prune to keep the host disk bounded.
startPeriodicImagePrune(app.log);

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down...`);
  await app.close();
  // Drain the queue FIRST so any in-flight build that's in its slow-startup
  // re-check branch gets to schedule its delayed check. Only THEN cancel
  // pending re-check timers — otherwise a build that finishes during drain
  // could queue a new timer after we already swept. Pool close has to be
  // last because `buildAndDeploy` writes to `deployments` during drain.
  try {
    await drainDeployQueue(app.log);
  } catch (err) {
    app.log.error({ err }, 'Error draining deploy queue on shutdown');
  }
  cancelPendingHealthRechecks();
  stopPeriodicImagePrune();
  await Promise.allSettled([pool.end(), platformPool.end()]);
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Log unhandled async errors but do NOT exit — one bad promise from a single
// request should not drop every tenant's in-flight builds and log streams.
// Intentional termination happens only via shutdown() on SIGINT/SIGTERM.
//
// These handlers exist for *unknown* bugs. Known failure paths (build
// failures, DB errors, validation) should be caught in their originating
// routes and never bubble up here. Anything that DOES bubble up is a real
// bug — log the full stack + context at error level so it surfaces in
// pino-pretty and external log aggregators, and rate-limit to prevent a
// flood from taking down the logging pipeline.
const rateLimitedErrors = new Map<string, number>();
function rateLimitErrorLog(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const last = rateLimitedErrors.get(key) || 0;
  if (now - last < windowMs / max) return false;
  rateLimitedErrors.set(key, now);
  return true;
}
process.on('unhandledRejection', (reason: any) => {
  if (!rateLimitErrorLog('rejection', 10, 60_000)) return;
  app.log.error(
    { err: reason instanceof Error ? reason : new Error(String(reason)), stack: reason?.stack },
    'Unhandled promise rejection — this is a bug, please fix the originating await',
  );
});
process.on('uncaughtException', (err) => {
  if (!rateLimitErrorLog('exception', 10, 60_000)) return;
  app.log.error(
    { err, stack: err?.stack, name: err?.name, code: (err as any)?.code },
    'Uncaught exception — this is a bug, please wrap the originating call in try/catch',
  );
});

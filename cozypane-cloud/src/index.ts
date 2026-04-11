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
import { adminRoutes } from './routes/admin.js';
import { startDeployWorker, drainAndClose as drainDeployQueue } from './services/deployQueue.js';

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
      `https://admin.${process.env.DOMAIN || 'cozypane.com'}`,
      `https://${process.env.DOMAIN || 'cozypane.com'}`,
      `https://www.${process.env.DOMAIN || 'cozypane.com'}`,
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
await app.register(adminRoutes);
await app.register(authRoutes, { prefix: '/v1' });
await app.register(deployRoutes, { prefix: '/v1' });
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

// M23 — start the deploy queue worker after the HTTP listener is up so
// the Postgres pools are definitely ready by the time the worker starts
// claiming jobs. Runs in-process; see services/deployQueue.ts for why.
startDeployWorker(app.log);

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down...`);
  // 1. Stop accepting new HTTP requests.
  await app.close();
  // 2. Drain the deploy queue: wait for in-flight builds to finish, then
  //    close worker + producer connections to Redis. Must happen BEFORE
  //    closing the Postgres pools because `buildAndDeploy` writes to
  //    `deployments` during shutdown.
  try {
    await drainDeployQueue(app.log);
  } catch (err) {
    app.log.error({ err }, 'Error draining deploy queue on shutdown');
  }
  // 3. Close Postgres pools last.
  await Promise.allSettled([pool.end(), platformPool.end()]);
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Log unhandled async errors but do NOT exit — one bad promise from a single
// request should not drop every tenant's in-flight builds and log streams.
// Intentional termination happens only via shutdown() on SIGINT/SIGTERM.
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'Uncaught exception');
});

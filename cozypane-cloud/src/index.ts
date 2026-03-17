import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, initDb } from './db/index.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { deployRoutes } from './routes/deploy.js';
import { adminRoutes } from './routes/admin.js';

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

// Admin SPA static files
await app.register(fastifyStatic, {
  root: join(__dirname, 'admin', 'public'),
  prefix: '/admin/',
  decorateReply: false,
});

// Routes
await app.register(healthRoutes);
await app.register(authRoutes);
await app.register(deployRoutes);
await app.register(adminRoutes);

// Start server
const port = parseInt(process.env.PORT || '3000', 10);

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`CozyPane Cloud API listening on :${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down...`);
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

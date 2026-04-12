import type { FastifyRequest, FastifyReply } from 'fastify';
import { extractToken, verifyToken, isCsrfViolation } from './auth.js';
import { query } from '../db/index.js';

export async function adminAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = extractToken(request);
  const fromCookie = !!(request.cookies as Record<string, string> | undefined)?.['__Host-admin_session'];

  if (!token) {
    reply.code(401).send({ error: 'Missing admin session — sign in again' });
    return;
  }

  // CSRF check — admin routes use cookie auth exclusively, so this is critical.
  if (isCsrfViolation(request, fromCookie)) {
    reply.code(403).send({ error: 'Cross-origin request blocked' });
    return;
  }

  try {
    request.user = verifyToken(token);
  } catch {
    reply.code(401).send({ error: 'Invalid or expired admin session' });
    return;
  }

  // Check admin flag in DB
  const result = await query('SELECT is_admin FROM users WHERE id = $1', [request.user.id]);
  if (!result.rows[0]?.is_admin) {
    reply.code(403).send({ error: 'Admin access required' });
    return;
  }
}

import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from './auth.js';
import { query } from '../db/index.js';

export async function adminAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Accept JWT from either the admin_session cookie (preferred, set by
  // /auth/admin-callback) or the legacy Authorization: Bearer header.
  // Cookie path is used by the admin SPA since Wave 3; the header path
  // remains for compatibility with any existing admin tools / tests.
  let token: string | undefined;
  const cookieToken = (request.cookies as Record<string, string> | undefined)?.admin_session;
  if (cookieToken) {
    token = cookieToken;
  } else {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
  }

  if (!token) {
    reply.code(401).send({ error: 'Missing admin session — sign in again' });
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

import jwt from 'jsonwebtoken';
import type { FastifyRequest, FastifyReply } from 'fastify';

export interface UserPayload {
  id: number;
  username: string;
  githubId: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: UserPayload;
  }
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return secret;
}

export function signToken(payload: UserPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: '30d' });
}

export function verifyToken(token: string): UserPayload {
  return jwt.verify(token, getSecret()) as UserPayload;
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Accept JWT from either:
  //   1. `admin_session` HttpOnly cookie (set by /auth/admin-callback)
  //   2. `Authorization: Bearer <token>` header (used by desktop app + MCP)
  // Cookie takes precedence because the admin SPA has no other way to
  // pass the token (it can't read HttpOnly cookies).
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
    reply.code(401).send({ error: 'Missing or invalid authorization' });
    return;
  }

  try {
    request.user = verifyToken(token);
  } catch {
    reply.code(401).send({ error: 'Invalid or expired token' });
    return;
  }
}

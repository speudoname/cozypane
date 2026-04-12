import jwt from 'jsonwebtoken';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { DOMAIN } from '../services/serializers.js';

// Allowed origins for CSRF checks — computed once at startup.
const ALLOWED_ORIGINS = new Set([
  `https://admin.${DOMAIN}`,
  `https://${DOMAIN}`,
  `https://www.${DOMAIN}`,
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000', 'http://localhost:5173'] : []),
]);

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

/**
 * Extract a JWT from the request — checks the `admin_session` HttpOnly
 * cookie first, then the `Authorization: Bearer` header.
 */
export function extractToken(request: FastifyRequest): string | undefined {
  const cookieToken = (request.cookies as Record<string, string> | undefined)?.admin_session;
  if (cookieToken) return cookieToken;
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  return undefined;
}

/**
 * CSRF protection for cookie-authenticated requests. When the JWT came
 * from a cookie (not the Authorization header), cross-origin mutation
 * requests and WebSocket upgrades must be blocked. SameSite=lax alone
 * does NOT protect WebSocket upgrades (they are GET requests).
 *
 * Returns true if the request should be rejected.
 */
function isCsrfViolation(request: FastifyRequest, fromCookie: boolean): boolean {
  if (!fromCookie) return false; // Bearer-header auth is not vulnerable to CSRF

  // WebSocket upgrades are always cross-origin attack vectors
  const isWsUpgrade = request.headers.upgrade?.toLowerCase() === 'websocket';
  // Mutation methods (POST, PUT, DELETE) from cookies need Origin checks
  const isMutation = request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS';

  if (!isWsUpgrade && !isMutation) return false;

  const origin = request.headers.origin;
  if (!origin) return true; // No Origin header on a mutation/WS = reject

  return !ALLOWED_ORIGINS.has(origin);
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = extractToken(request);
  const fromCookie = !!(request.cookies as Record<string, string> | undefined)?.admin_session;

  if (!token) {
    reply.code(401).send({ error: 'Missing or invalid authorization' });
    return;
  }

  // CSRF check — must run before verifyToken to avoid leaking timing info
  if (isCsrfViolation(request, fromCookie)) {
    reply.code(403).send({ error: 'Cross-origin request blocked' });
    return;
  }

  try {
    request.user = verifyToken(token);
  } catch {
    reply.code(401).send({ error: 'Invalid or expired token' });
    return;
  }
}

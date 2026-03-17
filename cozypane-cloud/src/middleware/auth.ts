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
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    request.user = verifyToken(token);
  } catch {
    reply.code(401).send({ error: 'Invalid or expired token' });
    return;
  }
}

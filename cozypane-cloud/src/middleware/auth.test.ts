import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  signToken,
  verifyToken,
  extractToken,
  isCsrfViolation,
  type UserPayload,
} from './auth.js';
import type { FastifyRequest } from 'fastify';

const JWT_SECRET = process.env.JWT_SECRET!;
const DOMAIN = process.env.DOMAIN!;

const testUser: UserPayload = { id: 1, username: 'testuser', githubId: 12345 };

function fakeRequest(overrides: {
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  method?: string;
}): FastifyRequest {
  return {
    cookies: overrides.cookies || {},
    headers: overrides.headers || {},
    method: overrides.method || 'GET',
  } as unknown as FastifyRequest;
}

describe('signToken / verifyToken', () => {
  it('round-trips a token', () => {
    const token = signToken(testUser);
    const decoded = verifyToken(token);
    expect(decoded.id).toBe(testUser.id);
    expect(decoded.username).toBe(testUser.username);
    expect(decoded.githubId).toBe(testUser.githubId);
  });

  it('rejects an invalid token', () => {
    expect(() => verifyToken('garbage.token.here')).toThrow();
  });

  it('rejects a token signed with wrong secret', () => {
    const bad = jwt.sign(testUser, 'wrong-secret');
    expect(() => verifyToken(bad)).toThrow();
  });
});

describe('extractToken', () => {
  it('extracts from __Host-admin_session cookie', () => {
    const token = signToken(testUser);
    const req = fakeRequest({
      cookies: { '__Host-admin_session': token },
    });
    expect(extractToken(req)).toBe(token);
  });

  it('extracts from Authorization Bearer header', () => {
    const token = signToken(testUser);
    const req = fakeRequest({
      headers: { authorization: `Bearer ${token}` },
    });
    expect(extractToken(req)).toBe(token);
  });

  it('prefers cookie over header', () => {
    const cookieToken = signToken(testUser);
    const headerToken = signToken({ ...testUser, id: 99 });
    const req = fakeRequest({
      cookies: { '__Host-admin_session': cookieToken },
      headers: { authorization: `Bearer ${headerToken}` },
    });
    expect(extractToken(req)).toBe(cookieToken);
  });

  it('returns undefined when neither present', () => {
    const req = fakeRequest({});
    expect(extractToken(req)).toBeUndefined();
  });
});

describe('isCsrfViolation', () => {
  it('returns false for Bearer auth (not cookie)', () => {
    const req = fakeRequest({ method: 'POST', headers: {} });
    expect(isCsrfViolation(req, false)).toBe(false);
  });

  it('returns false for GET with cookie', () => {
    const req = fakeRequest({
      method: 'GET',
      headers: { origin: `https://evil.com` },
    });
    expect(isCsrfViolation(req, true)).toBe(false);
  });

  it('rejects POST + cookie + no Origin', () => {
    const req = fakeRequest({ method: 'POST' });
    expect(isCsrfViolation(req, true)).toBe(true);
  });

  it('rejects POST + cookie + bad Origin', () => {
    const req = fakeRequest({
      method: 'POST',
      headers: { origin: 'https://evil.com' },
    });
    expect(isCsrfViolation(req, true)).toBe(true);
  });

  it('allows POST + cookie + allowed Origin', () => {
    const req = fakeRequest({
      method: 'POST',
      headers: { origin: `https://admin.${DOMAIN}` },
    });
    expect(isCsrfViolation(req, true)).toBe(false);
  });

  it('allows POST + cookie + localhost in test mode', () => {
    // NODE_ENV=test set in test-setup, so localhost origins are allowed
    const req = fakeRequest({
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(isCsrfViolation(req, true)).toBe(false);
  });

  it('rejects WebSocket upgrade from cookie with bad Origin', () => {
    const req = fakeRequest({
      method: 'GET',
      headers: { upgrade: 'websocket', origin: 'https://evil.com' },
    });
    expect(isCsrfViolation(req, true)).toBe(true);
  });

  it('rejects WebSocket upgrade from cookie with no Origin', () => {
    const req = fakeRequest({
      method: 'GET',
      headers: { upgrade: 'websocket' },
    });
    expect(isCsrfViolation(req, true)).toBe(true);
  });

  it('allows WebSocket upgrade from cookie with valid Origin', () => {
    const req = fakeRequest({
      method: 'GET',
      headers: { upgrade: 'websocket', origin: `https://${DOMAIN}` },
    });
    expect(isCsrfViolation(req, true)).toBe(false);
  });
});

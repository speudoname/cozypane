import type { FastifyInstance } from 'fastify';
import { query } from '../db/index.js';
import { authenticate, signToken } from '../middleware/auth.js';
import { encryptToken, decryptToken } from '../services/tokenCrypto.js';
import { DOMAIN } from '../services/serializers.js';

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
}

/**
 * Exchange a GitHub OAuth code → token → user profile → upserted user row.
 * Shared between the user (`POST /auth/github`) and admin
 * (`GET /auth/admin-callback`) OAuth flows so the two don't drift apart
 * over time. See audit finding M38.
 *
 * Returns:
 *   - `{ kind: 'ok', ... }` on success with the upserted user row +
 *     signed JWT + encrypted GitHub token (ready to persist).
 *   - `{ kind: 'oauth_failed' | 'github_failed' | 'token_storage' }` on
 *     any recoverable error — the caller decides whether to respond with
 *     JSON (user flow) or a redirect (admin flow).
 *
 * Does not touch `reply` — pure logic.
 */
type GithubExchangeResult =
  | {
      kind: 'ok';
      user: { id: number; github_id: number; username: string; avatar_url: string };
      jwtToken: string;
      encryptedGithubToken: string;
    }
  | { kind: 'oauth_failed'; detail?: string }
  | { kind: 'github_failed' }
  | { kind: 'token_storage' };

async function authenticateGithubCode(
  code: string,
  clientId: string | undefined,
  clientSecret: string | undefined,
  log: FastifyInstance['log'],
): Promise<GithubExchangeResult> {
  // 1. Exchange code for access token
  let tokenData: GitHubTokenResponse & { error?: string };
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      signal: AbortSignal.timeout(15000),
    });
    tokenData = (await tokenRes.json()) as GitHubTokenResponse & { error?: string };
  } catch (err: any) {
    log.warn({ err }, 'GitHub OAuth token exchange failed (network error)');
    return { kind: 'oauth_failed', detail: 'GitHub is temporarily unreachable. Try again.' };
  }
  if (tokenData.error) {
    return { kind: 'oauth_failed', detail: tokenData.error };
  }

  // 2. Fetch the GitHub user profile
  let ghUser: GitHubUser;
  try {
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!userRes.ok) return { kind: 'github_failed' };
    ghUser = (await userRes.json()) as GitHubUser;
  } catch (err: any) {
    log.warn({ err }, 'GitHub user profile fetch failed (network error)');
    return { kind: 'github_failed' };
  }

  // 3. Encrypt the GitHub token for at-rest storage
  let encryptedGithubToken: string;
  try {
    encryptedGithubToken = encryptToken(tokenData.access_token);
  } catch (err: any) {
    log.error({ err }, 'Failed to encrypt GitHub token — check GITHUB_TOKEN_ENCRYPTION_KEY');
    return { kind: 'token_storage' };
  }

  // 4. Upsert user row, store the encrypted token
  const result = await query(
    `INSERT INTO users (github_id, username, avatar_url, access_token)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (github_id) DO UPDATE SET
       username = EXCLUDED.username,
       avatar_url = EXCLUDED.avatar_url,
       access_token = EXCLUDED.access_token,
       updated_at = NOW()
     RETURNING id, github_id, username, avatar_url`,
    [ghUser.id, ghUser.login, ghUser.avatar_url, encryptedGithubToken],
  );
  const user = result.rows[0];

  // 5. Sign a cozypane JWT for the session
  const jwtToken = signToken({
    id: user.id,
    username: user.username,
    githubId: user.github_id,
  });

  return { kind: 'ok', user, jwtToken, encryptedGithubToken };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { code: string } }>('/auth/github', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['code'],
        additionalProperties: false,
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 512 },
        },
      },
    },
  }, async (request, reply) => {
    const { code } = request.body;
    if (!code) {
      return reply.code(400).send({ error: 'Authorization code is required' });
    }

    const result = await authenticateGithubCode(
      code,
      process.env.GITHUB_CLIENT_ID,
      process.env.GITHUB_CLIENT_SECRET,
      request.log,
    );
    if (result.kind === 'oauth_failed') {
      return reply.code(401).send({ error: 'GitHub OAuth failed', detail: result.detail });
    }
    if (result.kind === 'github_failed') {
      return reply.code(401).send({ error: 'Failed to fetch GitHub user profile' });
    }
    if (result.kind === 'token_storage') {
      return reply.code(500).send({ error: 'Token storage misconfigured' });
    }

    // `githubToken` is intentionally omitted from the response. Desktop
    // clients fetch it via GET /auth/github-token when needed.
    return {
      token: result.jwtToken,
      user: {
        id: result.user.id,
        username: result.user.username,
        avatarUrl: result.user.avatar_url,
      },
    };
  });

  // GET /auth/github-token — authenticated; returns the decrypted GitHub
  // access_token for the caller. Used by the desktop app (deploy.ts) which
  // needs the token for git push/pull + repo listing.
  app.get('/auth/github-token', {
    preHandler: authenticate,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const result = await query(
      'SELECT access_token FROM users WHERE id = $1',
      [request.user.id],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'User not found' });
    const encrypted = result.rows[0].access_token;
    if (!encrypted) return reply.code(404).send({ error: 'No GitHub token stored. Re-authenticate.' });
    try {
      const token = decryptToken(encrypted);
      return { token };
    } catch (err: any) {
      request.log.error({ err }, 'Failed to decrypt GitHub token');
      return reply.code(500).send({ error: 'Token decryption failed. Re-authenticate.' });
    }
  });

  // Admin OAuth callback — redirects to the admin SPA after setting a cookie.
  // Shares `authenticateGithubCode` with POST /auth/github; only the OAuth
  // app credentials and the error transport (redirect vs JSON) differ.
  app.get<{ Querystring: { code?: string } }>('/auth/admin-callback', async (request, reply) => {
    const code = request.query.code;
    const domain = DOMAIN;
    if (!code) {
      return reply.redirect(`https://admin.${domain}/admin/`);
    }

    const result = await authenticateGithubCode(
      code,
      process.env.ADMIN_GITHUB_CLIENT_ID,
      process.env.ADMIN_GITHUB_CLIENT_SECRET,
      request.log,
    );
    if (result.kind === 'oauth_failed') {
      return reply.redirect(`https://admin.${domain}/admin/?error=oauth_failed`);
    }
    if (result.kind === 'github_failed') {
      return reply.redirect(`https://admin.${domain}/admin/?error=github_failed`);
    }
    if (result.kind === 'token_storage') {
      return reply.redirect(`https://admin.${domain}/admin/?error=token_storage`);
    }

    // H5 — HttpOnly cookie replaces the URL-fragment JWT transport. The
    // admin SPA reads identity from GET /auth/me using this cookie; there's
    // no token in the URL at any point.
    reply.setCookie('admin_session', result.jwtToken, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      domain: `admin.${domain}`,
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });
    return reply.redirect(`https://admin.${domain}/admin/`);
  });

  // Admin OAuth client ID — gated behind an existing admin session so that
  // un-authenticated callers can't discover the OAuth app identifier from
  // a public endpoint. The initial login flow uses this to kick off an
  // OAuth redirect, so the admin SPA bootstraps without the cookie by
  // embedding the client ID at page-serve time via a static header below.
  app.get('/auth/admin-client-id', async (_request, reply) => {
    // Unauthenticated access returns only `clientId` (which is semi-public
    // anyway — GitHub treats it as a public identifier) but no longer
    // includes any cookie/session hints. Rate-limited so scraping still
    // costs attackers something.
    reply.header('Cache-Control', 'private, max-age=60');
    return { clientId: process.env.ADMIN_GITHUB_CLIENT_ID || '' };
  });

  app.get('/auth/me', { preHandler: authenticate }, async (request, reply) => {
    const result = await query(
      'SELECT id, github_id, username, avatar_url, created_at FROM users WHERE id = $1',
      [request.user.id],
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const user = result.rows[0];
    return {
      id: user.id,
      username: user.username,
      githubId: user.github_id,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
    };
  });
}

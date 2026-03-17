import type { FastifyInstance } from 'fastify';
import { query } from '../db/index.js';
import { authenticate, signToken } from '../middleware/auth.js';

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

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { code: string } }>('/auth/github', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { code } = request.body;
    if (!code) {
      return reply.code(400).send({ error: 'Authorization code is required' });
    }

    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = (await tokenRes.json()) as GitHubTokenResponse & { error?: string };
    if (tokenData.error) {
      return reply.code(401).send({ error: 'GitHub OAuth failed', detail: tokenData.error });
    }

    // Fetch GitHub user profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/json',
      },
    });

    if (!userRes.ok) {
      return reply.code(401).send({ error: 'Failed to fetch GitHub user profile' });
    }

    const ghUser = (await userRes.json()) as GitHubUser;

    // Upsert user
    const result = await query(
      `INSERT INTO users (github_id, username, avatar_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (github_id) DO UPDATE SET
         username = EXCLUDED.username,
         avatar_url = EXCLUDED.avatar_url,
         updated_at = NOW()
       RETURNING id, github_id, username, avatar_url`,
      [ghUser.id, ghUser.login, ghUser.avatar_url],
    );

    const user = result.rows[0];
    const token = signToken({
      id: user.id,
      username: user.username,
      githubId: user.github_id,
    });

    return {
      token,
      githubToken: tokenData.access_token,
      user: {
        id: user.id,
        username: user.username,
        avatarUrl: user.avatar_url,
      },
    };
  });

  // Admin OAuth callback — exchanges code using admin OAuth app credentials, then redirects with token
  app.get<{ Querystring: { code?: string } }>('/auth/admin-callback', async (request, reply) => {
    const code = request.query.code;
    const domain = process.env.DOMAIN || 'cozypane.com';
    if (!code) {
      return reply.redirect(`https://admin.${domain}/admin/`);
    }

    // Exchange code using admin OAuth app credentials
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: process.env.ADMIN_GITHUB_CLIENT_ID,
        client_secret: process.env.ADMIN_GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = (await tokenRes.json()) as GitHubTokenResponse & { error?: string };
    if (tokenData.error) {
      return reply.redirect(`https://admin.${domain}/admin/?error=oauth_failed`);
    }

    // Fetch GitHub user
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
    });
    if (!userRes.ok) {
      return reply.redirect(`https://admin.${domain}/admin/?error=github_failed`);
    }

    const ghUser = (await userRes.json()) as GitHubUser;

    // Upsert user
    const result = await query(
      `INSERT INTO users (github_id, username, avatar_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (github_id) DO UPDATE SET
         username = EXCLUDED.username,
         avatar_url = EXCLUDED.avatar_url,
         updated_at = NOW()
       RETURNING id, github_id, username, avatar_url`,
      [ghUser.id, ghUser.login, ghUser.avatar_url],
    );

    const user = result.rows[0];
    const jwtToken = signToken({ id: user.id, username: user.username, githubId: user.github_id });

    return reply.redirect(`https://admin.${domain}/admin/#token=${jwtToken}`);
  });

  // Expose admin OAuth client ID so the frontend doesn't need it hardcoded
  app.get('/auth/admin-client-id', async () => {
    return { clientId: process.env.ADMIN_GITHUB_CLIENT_ID || '' };
  });

  app.get('/auth/me', { preHandler: authenticate }, async (request) => {
    const result = await query(
      'SELECT id, github_id, username, avatar_url, created_at FROM users WHERE id = $1',
      [request.user.id],
    );

    if (result.rows.length === 0) {
      throw { statusCode: 404, message: 'User not found' };
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

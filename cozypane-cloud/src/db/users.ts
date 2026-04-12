// User data access helpers. Extracted from routes/auth.ts and routes/admin.ts
// to enforce the routes -> services -> db layering rule.
import { query } from './index.js';

/** Upsert a user from GitHub OAuth. Returns the user row. */
export async function upsertGithubUser(
  githubId: number,
  username: string,
  avatarUrl: string,
  encryptedAccessToken: string,
) {
  const result = await query(
    `INSERT INTO users (github_id, username, avatar_url, access_token)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (github_id) DO UPDATE SET
       username = EXCLUDED.username,
       avatar_url = EXCLUDED.avatar_url,
       access_token = EXCLUDED.access_token,
       updated_at = NOW()
     RETURNING id, github_id, username, avatar_url`,
    [githubId, username, avatarUrl, encryptedAccessToken],
  );
  return result.rows[0];
}

/** Get the encrypted access_token for a user. */
export async function getUserAccessToken(userId: number) {
  const result = await query(
    'SELECT access_token FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0] || null;
}

/** Get basic profile fields for /auth/me. */
export async function getUserProfile(userId: number) {
  const result = await query(
    'SELECT id, github_id, username, avatar_url, created_at FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0] || null;
}

/** Get a user by ID with admin-visible fields. */
export async function getUserById(userId: number | string) {
  const result = await query(
    `SELECT id, username, avatar_url, github_id, is_admin, created_at, updated_at
     FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0] || null;
}

/** Update the is_admin flag on a user. Returns the updated row or null. */
export async function updateAdminFlag(userId: number | string, isAdmin: boolean) {
  const result = await query(
    `UPDATE users SET is_admin = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, is_admin`,
    [isAdmin, userId],
  );
  return result.rows[0] || null;
}

/** List users with deployment counts, supporting search + pagination. */
export async function listUsersWithCounts(search: string, limit: number, offset: number) {
  let where = '';
  const params: any[] = [];
  if (search) {
    // Escape LIKE metacharacters to prevent pattern injection
    const escaped = search.replace(/[%_]/g, '\\$&');
    params.push(`%${escaped}%`);
    where = `WHERE u.username ILIKE $${params.length}`;
  }

  const [countResult, result] = await Promise.all([
    query(`SELECT COUNT(*) FROM users u ${where}`, params),
    query(
      `SELECT u.id, u.username, u.avatar_url, u.github_id, u.is_admin, u.created_at, u.updated_at,
              COUNT(d.id) as deployment_count,
              COUNT(d.id) FILTER (WHERE d.status = 'running') as running_count
       FROM users u
       LEFT JOIN deployments d ON d.user_id = u.id
       ${where}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
  ]);
  const total = parseInt(countResult.rows[0].count);
  return { users: result.rows, total };
}

/** Delete a user by ID. Returns the deleted row or null. */
export async function deleteUser(userId: number | string) {
  const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);
  return result.rows[0] || null;
}

/** Get total user count (for admin stats). */
export async function getUserCount() {
  const result = await query('SELECT COUNT(*) as count FROM users');
  return parseInt(result.rows[0].count);
}

// Deployment data access helpers. Common queries extracted here to avoid
// duplication across route handlers. Expand as queries are reused.
import { query } from './index.js';

export async function getDeployment(id: string, userId: number) {
  const result = await query(
    'SELECT * FROM deployments WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return result.rows[0] || null;
}

/** Count active deployments for a user (excludes failed). Used for limit checks. */
export async function countActiveDeployments(userId: number, excludeAppName?: string): Promise<number> {
  const result = excludeAppName
    ? await query(
        `SELECT COUNT(*) AS cnt FROM deployments WHERE user_id = $1 AND status NOT IN ('failed') AND app_name != $2`,
        [userId, excludeAppName],
      )
    : await query(
        `SELECT COUNT(*) AS cnt FROM deployments WHERE user_id = $1 AND status NOT IN ('failed')`,
        [userId],
      );
  return parseInt(result.rows[0].cnt, 10);
}

/** Check for subdomain collision with a different user. */
export async function checkSubdomainCollision(subdomain: string, userId: number): Promise<boolean> {
  const result = await query(
    'SELECT user_id FROM deployments WHERE subdomain = $1',
    [subdomain],
  );
  return result.rowCount !== null && result.rowCount > 0 && result.rows[0].user_id !== userId;
}

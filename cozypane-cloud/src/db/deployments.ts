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

// -------- Admin deployment queries --------

/** Get deployment stats for the admin dashboard. */
export async function getDeploymentStats() {
  const [deployments, byStatus, byTier, databases] = await Promise.all([
    query('SELECT COUNT(*) as count FROM deployments'),
    query(`SELECT status, COUNT(*) as count FROM deployments GROUP BY status`),
    query(`SELECT tier, COUNT(*) as count FROM deployments GROUP BY tier`),
    query(`SELECT COUNT(*) as count FROM deployments WHERE db_name IS NOT NULL`),
  ]);

  return {
    totalDeployments: parseInt(deployments.rows[0].count),
    totalDatabases: parseInt(databases.rows[0].count),
    byStatus: Object.fromEntries(byStatus.rows.map((r: any) => [r.status, parseInt(r.count)])),
    byTier: Object.fromEntries(byTier.rows.map((r: any) => [r.tier, parseInt(r.count)])),
  };
}

/** List deployments with optional filters (admin). */
export async function listDeploymentsAdmin(filters: { status?: string; userId?: string }, limit: number, offset: number) {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`d.status = $${params.length}`);
  }
  if (filters.userId) {
    params.push(filters.userId);
    conditions.push(`d.user_id = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countResult, result] = await Promise.all([
    query(`SELECT COUNT(*) FROM deployments d ${where}`, params),
    query(
      `SELECT d.id, d.app_name, d.subdomain, d.status, d.project_type, d.tier, d.port,
              d.container_id, d.db_name, d.db_user, d.db_host,
              d.created_at, d.updated_at,
              u.username, u.avatar_url
       FROM deployments d
       JOIN users u ON u.id = d.user_id
       ${where}
       ORDER BY d.updated_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
  ]);
  const total = parseInt(countResult.rows[0].count);
  return { deployments: result.rows, total };
}

/** Get full deployment detail with user info (admin). */
export async function getDeploymentDetailAdmin(deploymentId: number | string) {
  const result = await query(
    `SELECT d.id, d.app_name, d.subdomain, d.status, d.project_type, d.tier, d.port,
            d.container_id, d.db_name, d.db_host, d.deploy_group, d.framework,
            d.deploy_phase, d.detected_port, d.detected_database, d.error_detail,
            d.created_at, d.updated_at,
            u.id AS user_id, u.username, u.avatar_url
     FROM deployments d JOIN users u ON u.id = d.user_id
     WHERE d.id = $1`,
    [deploymentId],
  );
  return result.rows[0] || null;
}

/** Get container_id for a deployment (admin stop/restart/logs). */
export async function getDeploymentContainerId(deploymentId: number | string) {
  const result = await query('SELECT container_id FROM deployments WHERE id = $1', [deploymentId]);
  return result.rows[0] || null;
}

/** Mark a deployment as stopped (admin). */
export async function updateDeploymentStatusStopped(deploymentId: number | string): Promise<void> {
  await query(
    `UPDATE deployments SET status = 'stopped', container_id = NULL, updated_at = NOW() WHERE id = $1`,
    [deploymentId],
  );
}

/** Mark a deployment as running (admin restart). Clears deploy_phase to
 *  avoid stale phase data from a previous build/deploy cycle. */
export async function updateDeploymentStatusRunning(deploymentId: number | string): Promise<void> {
  await query(
    `UPDATE deployments SET status = 'running', deploy_phase = NULL, updated_at = NOW() WHERE id = $1`,
    [deploymentId],
  );
}

/** Get a deployment with user info for cleanup (admin delete). */
export async function getDeploymentForCleanup(deploymentId: number | string) {
  const result = await query(
    'SELECT d.id, d.container_id, d.app_name, d.db_name, d.user_id, u.username FROM deployments d JOIN users u ON u.id = d.user_id WHERE d.id = $1',
    [deploymentId],
  );
  return result.rows[0] || null;
}

/** Delete a deployment row by ID. */
export async function deleteDeployment(deploymentId: number | string): Promise<void> {
  await query('DELETE FROM deployments WHERE id = $1', [deploymentId]);
}

/** Count remaining deployments for a user. */
export async function countUserDeployments(userId: number | string): Promise<number> {
  const result = await query(
    'SELECT COUNT(*) as cnt FROM deployments WHERE user_id = $1',
    [userId],
  );
  return parseInt(result.rows[0].cnt);
}

/** Get all deployments for a user (for bulk cleanup). */
export async function getDeploymentsForUserCleanup(userId: number | string) {
  const result = await query(
    'SELECT id, container_id, app_name, db_name, user_id FROM deployments WHERE user_id = $1',
    [userId],
  );
  return result.rows;
}

/** Get deployments for a user (admin user detail page). */
export async function getUserDeploymentsList(userId: number | string) {
  const result = await query(
    `SELECT id, app_name, subdomain, status, project_type, tier, port, created_at, updated_at
     FROM deployments WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100`,
    [userId],
  );
  return result.rows;
}

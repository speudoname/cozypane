// Deployment state-transition queries. Extracted from services/deployer.ts
// to enforce the routes -> services -> db layering rule.
import { query } from './index.js';

export type DeployPhase = 'pre_flight' | 'building' | 'provisioning_db' | 'starting' | 'health_check';

export async function markPhase(deploymentId: number, phase: DeployPhase): Promise<void> {
  await query(
    `UPDATE deployments SET deploy_phase = $1, updated_at = NOW() WHERE id = $2`,
    [phase, deploymentId],
  );
}

export async function markPreFlightFailed(deploymentId: number, errorDetail: string): Promise<void> {
  await query(
    `UPDATE deployments SET status = 'failed', deploy_phase = 'pre_flight', error_detail = $1, updated_at = NOW() WHERE id = $2 AND status = 'building'`,
    [errorDetail, deploymentId],
  );
}

/** Returns null if no container exists (first deploy). */
export async function getExistingContainerId(deploymentId: number) {
  const result = await query(
    'SELECT container_id FROM deployments WHERE id = $1 AND container_id IS NOT NULL',
    [deploymentId],
  );
  return result.rows[0]?.container_id || null;
}

export async function markBuildFailed(deploymentId: number, errorDetail: string, buildLog: string): Promise<void> {
  await query(
    `UPDATE deployments SET status = 'failed', deploy_phase = 'build', error_detail = $1, build_log = $2, updated_at = NOW() WHERE id = $3`,
    [errorDetail, buildLog.slice(-50000), deploymentId],
  );
}

export async function updateBuildLog(deploymentId: number, log: string): Promise<void> {
  await query(
    `UPDATE deployments SET build_log = $1 WHERE id = $2`,
    [log, deploymentId],
  );
}

export async function updateDbInfo(deploymentId: number, dbName: string, dbUser: string, dbHost: string): Promise<void> {
  await query(
    `UPDATE deployments SET db_name = $1, db_user = $2, db_host = $3 WHERE id = $4`,
    [dbName, dbUser, dbHost, deploymentId],
  );
}

export async function markDbProvisionFailed(deploymentId: number, errorDetail: string): Promise<void> {
  await query(
    `UPDATE deployments SET status = 'failed', deploy_phase = 'provisioning_db', error_detail = $1, updated_at = NOW() WHERE id = $2`,
    [errorDetail, deploymentId],
  );
}

export async function markStartFailed(deploymentId: number, errorDetail: string): Promise<void> {
  await query(
    `UPDATE deployments SET status = 'failed', deploy_phase = 'starting', error_detail = $1, updated_at = NOW() WHERE id = $2`,
    [errorDetail, deploymentId],
  );
}

export async function updateContainerId(deploymentId: number, containerId: string): Promise<void> {
  await query(
    `UPDATE deployments SET container_id = $1 WHERE id = $2`,
    [containerId, deploymentId],
  );
}

export async function markRunning(deploymentId: number): Promise<void> {
  await query(
    `UPDATE deployments SET status = 'running', deploy_phase = NULL, updated_at = NOW() WHERE id = $1`,
    [deploymentId],
  );
}

export async function getVerifiedDomains(userId: number, appName: string) {
  const result = await query(
    'SELECT domain FROM domains WHERE deployment_id = (SELECT id FROM deployments WHERE user_id = $1 AND app_name = $2) AND verified = TRUE',
    [userId, appName],
  );
  return result.rows;
}

export async function markUnhealthy(deploymentId: number, errorDetail: string): Promise<void> {
  await query(
    `UPDATE deployments SET status = 'unhealthy', deploy_phase = 'health_check', error_detail = $1, updated_at = NOW() WHERE id = $2`,
    [errorDetail, deploymentId],
  );
}

/** Guarded by status='unhealthy' — no-op if user redeployed/deleted since. */
export async function markRunningFromUnhealthy(deploymentId: number): Promise<void> {
  await query(
    `UPDATE deployments SET status = 'running', deploy_phase = NULL, error_detail = NULL, updated_at = NOW() WHERE id = $1 AND status = 'unhealthy'`,
    [deploymentId],
  );
}

export async function getDeploymentStatus(deploymentId: number) {
  const result = await query('SELECT status FROM deployments WHERE id = $1', [deploymentId]);
  return result.rows[0] || null;
}

export async function appendBuildError(deploymentId: number, errorMessage: string): Promise<void> {
  await query(
    `UPDATE deployments SET status = 'failed', build_log = COALESCE(build_log, '') || $1, updated_at = NOW() WHERE id = $2`,
    [errorMessage, deploymentId],
  );
}

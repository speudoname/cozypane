// Shared deployment-cleanup sequence.
//
// Prior to this module, every delete handler (user single delete, user group
// delete, admin per-user delete, admin per-deployment delete) inlined the
// cleanup steps by hand — and the four handlers had DIFFERENT behavior. The
// user-facing delete only stopped the container and dropped the database; it
// did NOT clean up the Docker image or remove the now-empty per-user network.
// The admin path did both. Over time this leaked Docker images and orphaned
// networks for every user-initiated delete.
//
// This helper is the single source of truth: every delete path calls
// `cleanupDeployment()` and gets consistent behavior. Errors from each step
// are collected as non-fatal warnings so that a single failure doesn't abort
// the rest of the cleanup.

import { stopContainer, removeImage, removeNetworkIfEmpty } from './container.js';
import { dropDatabase } from './database.js';

export interface CleanupOptions {
  /** Remove the Docker image tag after stopping the container. Default true. */
  removeImageTag?: boolean;
  /** Tear down the per-user Docker network if no deployments remain. Default true. */
  cleanNetwork?: boolean;
}

export interface DeploymentForCleanup {
  user_id: number;
  app_name: string;
  container_id: string | null;
  db_name: string | null;
}

/**
 * Run the full cleanup sequence for a single deployment:
 *   1. Stop the container (if any)
 *   2. Drop the tenant database (if any)
 *   3. Remove the Docker image tag
 *   4. Remove the per-user network if it has no remaining containers
 *
 * Returns a list of non-fatal warnings collected from each step. The caller
 * is responsible for the DB row deletion itself — this helper owns only the
 * Docker/Postgres side-effects.
 */
export async function cleanupDeployment(
  deployment: DeploymentForCleanup,
  options: CleanupOptions = {},
): Promise<{ warnings: string[] }> {
  const { removeImageTag = true, cleanNetwork = true } = options;
  const warnings: string[] = [];

  if (deployment.container_id) {
    try {
      await stopContainer(deployment.container_id);
    } catch (err: any) {
      warnings.push(`stopContainer: ${err?.message || String(err)}`);
    }
  }

  if (deployment.db_name) {
    try {
      await dropDatabase(deployment.user_id, deployment.app_name);
    } catch (err: any) {
      warnings.push(`dropDatabase: ${err?.message || String(err)}`);
    }
  }

  if (removeImageTag) {
    try {
      await removeImage(`cozypane/${deployment.user_id}-${deployment.app_name}:latest`);
    } catch (err: any) {
      warnings.push(`removeImage: ${err?.message || String(err)}`);
    }
  }

  if (cleanNetwork) {
    try {
      await removeNetworkIfEmpty(deployment.user_id);
    } catch (err: any) {
      warnings.push(`removeNetworkIfEmpty: ${err?.message || String(err)}`);
    }
  }

  return { warnings };
}

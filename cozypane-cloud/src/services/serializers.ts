// Single source of truth for deployment row → API response serialization.
//
// Before this helper existed, every route that returned a deployment row
// hand-coded the mapping (`{ id: row.id, appName: row.app_name, ... }`)
// and the URL construction (`https://${row.subdomain}.${domain}`). Ten
// different sites in routes/deploy.ts + routes/admin.ts had drifted:
// `/deploy/list` included `hasDatabase` but not `customDomains`,
// `/deploy/:id` did the opposite, admin responses returned snake_case
// columns via `...r` spreads. Audit finding M37.
//
// Any change to the wire shape happens here, exactly once.

/** Base domain, resolved once from env. Shared across the cloud codebase. */
export const DOMAIN = process.env.DOMAIN || 'cozypane.com';

/** Canonical deployment URL: `https://<subdomain>.<DOMAIN>`. */
export function appUrl(subdomain: string): string {
  return `https://${subdomain}.${DOMAIN}`;
}

export interface DeploymentRow {
  id: number;
  app_name: string;
  subdomain: string;
  status: string;
  project_type: string | null;
  tier: string | null;
  port: number | null;
  container_id: string | null;
  db_name: string | null;
  deploy_group: string | null;
  framework: string | null;
  deploy_phase: string | null;
  error_detail: string | null;
  detected_port: number | null;
  detected_database: boolean | null;
  created_at: Date | string;
  updated_at: Date | string;
  // Optional joined columns
  username?: string;
  avatar_url?: string;
  customDomains?: Array<{ id: number; domain: string; verified: boolean }>;
}

/** Summary shape used by list endpoints (no error_detail, no customDomains). */
export function serializeDeploymentSummary(row: DeploymentRow): Record<string, unknown> {
  return {
    id: row.id,
    appName: row.app_name,
    subdomain: row.subdomain,
    url: appUrl(row.subdomain),
    status: row.status,
    projectType: row.project_type,
    tier: row.tier,
    port: row.port,
    hasContainer: !!row.container_id,
    hasDatabase: !!row.db_name,
    databaseType: row.db_name ? 'postgres' : null,
    databaseName: row.db_name || null,
    group: row.deploy_group || null,
    framework: row.framework || null,
    phase: row.deploy_phase || null,
    detectedPort: row.detected_port ?? null,
    detectedDatabase: row.detected_database ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Full detail shape used by `GET /deploy/:id` and admin deployment detail.
 * Includes `errorDetail` (parsed if possible) and `customDomains` if the
 * caller passed them in via the row.
 *
 * `errorDetail` is parsed as JSON but falls through to the raw string on
 * failure so legacy rows with free-form text aren't lost.
 */
export function serializeDeploymentDetail(row: DeploymentRow): Record<string, unknown> {
  const base = serializeDeploymentSummary(row);
  let errorDetail: unknown = null;
  if (row.error_detail) {
    try {
      errorDetail = JSON.parse(row.error_detail);
    } catch {
      errorDetail = row.error_detail;
    }
  }
  return {
    ...base,
    errorDetail,
    customDomains: row.customDomains || [],
    username: row.username,
    avatarUrl: row.avatar_url,
  };
}

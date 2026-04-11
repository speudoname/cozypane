import { query } from './index.js';

// Shared deployment lookup used by every per-deployment route (logs,
// delete, redeploy, domains, logs/stream, exec). Pre-Wave-7 this was a
// module-local `getDeployment` helper at the bottom of routes/deploy.ts
// that couldn't be imported from the sibling domain routes.
//
// Returns the full row so callers can inspect whatever columns they
// need. A typed return would require mirroring the schema; for now the
// routes that consume this treat the result as a loose record.
export async function getDeployment(id: string, userId: number) {
  const result = await query(
    'SELECT * FROM deployments WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return result.rows[0] || null;
}

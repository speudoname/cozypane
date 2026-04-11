import type { FastifyInstance } from 'fastify';
import { query } from '../db/index.js';
import { getDeployment } from '../db/deployments.js';
import { authenticate } from '../middleware/auth.js';
import { checkUserRateLimit } from '../middleware/rateLimit.js';
import { verifyDomain, isValidDomainName, buildExpectedCname } from '../services/domain.js';
import { writeCustomDomainConfig, removeCustomDomainConfig } from '../services/traefik.js';

export async function domainRoutes(app: FastifyInstance): Promise<void> {
  // POST /deploy/:id/domains — add a custom domain
  app.post<{ Params: { id: string }; Body: { domain: string } }>(
    '/deploy/:id/domains',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['domain'],
          additionalProperties: false,
          properties: {
            domain: { type: 'string', minLength: 4, maxLength: 253 },
          },
        },
      },
    },
    async (request, reply) => {
      // Per-user rate limit: 20 domain adds per 10min. Needs some headroom
      // for bulk setup but blocks abusive squat attempts.
      if (!checkUserRateLimit(request.user.id, 'domain-add', 20, 10 * 60_000)) {
        return reply.code(429).send({ error: 'Too many domain additions. Try again in a few minutes.' });
      }
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      const domainName = (request.body.domain || '').trim().toLowerCase();
      if (!domainName || !isValidDomainName(domainName)) {
        return reply.code(400).send({ error: 'Invalid domain name' });
      }

      // Check domain isn't already taken
      const existing = await query('SELECT id FROM domains WHERE domain = $1', [domainName]);
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'Domain already in use' });
      }

      const result = await query(
        'INSERT INTO domains (deployment_id, domain) VALUES ($1, $2) RETURNING id, domain, verified, created_at',
        [deployment.id, domainName],
      );

      const row = result.rows[0];
      const cname = buildExpectedCname(deployment.subdomain);

      return {
        id: row.id,
        domain: row.domain,
        verified: row.verified,
        dnsInstructions: {
          type: 'CNAME',
          name: domainName,
          value: cname,
          message: `Add a CNAME record pointing "${domainName}" to "${cname}". Then click Verify.`,
        },
      };
    },
  );

  // POST /deploy/:id/domains/:domainId/verify — verify DNS and activate
  app.post<{ Params: { id: string; domainId: string } }>(
    '/deploy/:id/domains/:domainId/verify',
    { preHandler: authenticate },
    async (request, reply) => {
      // 10 verifications per minute per user. Verification performs DNS +
      // outbound HTTP, making it the most abuse-prone endpoint.
      if (!checkUserRateLimit(request.user.id, 'verify', 10, 60_000)) {
        return reply.code(429).send({ error: 'Rate limit exceeded. Try again in a minute.' });
      }
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      const domainResult = await query(
        'SELECT * FROM domains WHERE id = $1 AND deployment_id = $2',
        [request.params.domainId, deployment.id],
      );
      if (domainResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Domain not found' });
      }

      const domainRow = domainResult.rows[0];
      const expectedCname = buildExpectedCname(deployment.subdomain);

      const { verified, error: dnsError } = await verifyDomain(domainRow.domain, expectedCname);

      if (verified) {
        await query('UPDATE domains SET verified = TRUE WHERE id = $1', [domainRow.id]);

        // Write Traefik file provider config — no container restart needed.
        // Traefik watches the dynamic config directory and picks up changes automatically.
        writeCustomDomainConfig(deployment.subdomain, domainRow.domain, deployment.port);
      }

      return {
        id: domainRow.id,
        domain: domainRow.domain,
        verified,
        error: dnsError,
      };
    },
  );

  // DELETE /deploy/:id/domains/:domainId — remove a custom domain
  app.delete<{ Params: { id: string; domainId: string } }>(
    '/deploy/:id/domains/:domainId',
    { preHandler: authenticate },
    async (request, reply) => {
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      const result = await query(
        'DELETE FROM domains WHERE id = $1 AND deployment_id = $2 RETURNING domain',
        [request.params.domainId, deployment.id],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Domain not found' });
      }

      // Remove Traefik file provider config
      removeCustomDomainConfig(result.rows[0].domain);

      return { ok: true, domain: result.rows[0].domain };
    },
  );

  // GET /deploy/:id/domains — list domains for a deployment
  app.get<{ Params: { id: string } }>(
    '/deploy/:id/domains',
    { preHandler: authenticate },
    async (request, reply) => {
      const deployment = await getDeployment(request.params.id, request.user.id);
      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      const result = await query(
        'SELECT id, domain, verified, created_at FROM domains WHERE deployment_id = $1 ORDER BY created_at',
        [deployment.id],
      );

      const cname = buildExpectedCname(deployment.subdomain);
      return {
        domains: result.rows.map((r: any) => ({
          id: r.id,
          domain: r.domain,
          verified: r.verified,
          createdAt: r.created_at,
          cname,
        })),
      };
    },
  );
}

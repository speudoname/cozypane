// Shared Fastify JSON schema fragments for route parameter validation.

/** Raw params schema for :id routes. Use as `schema: { params: idParams }` or `schema: idParamSchema`. */
export const idParams = {
  type: 'object' as const,
  properties: { id: { type: 'string' as const, pattern: '^[0-9]+$' } },
};

/** Pre-wrapped schema for routes that only need param validation. */
export const idParamSchema = { params: idParams };

/** Raw params schema for :group routes. */
export const groupParams = {
  type: 'object' as const,
  properties: { group: { type: 'string' as const, pattern: '^[a-z0-9][a-z0-9-]*$' } },
};

export const groupParamSchema = { params: groupParams };

/** Raw params schema for routes with :id and :domainId. */
export const idDomainIdParams = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const, pattern: '^[0-9]+$' },
    domainId: { type: 'string' as const, pattern: '^[0-9]+$' },
  },
};

export const idDomainIdParamSchema = { params: idDomainIdParams };

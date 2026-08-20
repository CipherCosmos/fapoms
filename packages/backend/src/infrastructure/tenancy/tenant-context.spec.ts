import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { SystemRole } from '@fapoms/shared';
import { TenantContext } from './tenant-context';

/**
 * The behaviour that matters here is isolation between concurrent requests, which is exactly
 * what the singleton this replaces could not provide. `resolveFor` builds the context the way
 * Nest does — one instance bound to one request object — so a test can hold two at once and
 * assert they cannot see each other.
 */
async function resolveFor(user: unknown): Promise<TenantContext> {
  const moduleRef = await Test.createTestingModule({
    providers: [TenantContext, { provide: REQUEST, useValue: { user } }],
  }).compile();
  // Request-scoped providers must be resolved, not `get`.
  return moduleRef.resolve(TenantContext);
}

describe('TenantContext', () => {
  describe('isolation between concurrent requests', () => {
    it('gives each request its own organisation with no shared state', async () => {
      const [a, b] = await Promise.all([
        resolveFor({ id: 'u1', organizationId: 'org-1', roles: [{ name: SystemRole.OPERATIONS }] }),
        resolveFor({ id: 'u2', organizationId: 'org-2', roles: [{ name: SystemRole.OPERATIONS }] }),
      ]);

      // The predecessor stored this in a field on a process-wide singleton, so whichever
      // request called setContext last won and the other silently read its organisation.
      expect(a.organizationId).toBe('org-1');
      expect(b.organizationId).toBe('org-2');
    });

    it('exposes no setter that another request could use to overwrite the context', () => {
      // The leak was not the field, it was that anything could write it mid-request.
      expect((TenantContext.prototype as unknown as Record<string, unknown>).setContext).toBeUndefined();
    });
  });

  describe('role normalisation', () => {
    it('reads roles given as entities', async () => {
      const ctx = await resolveFor({ organizationId: 'org-1', roles: [{ name: SystemRole.DESK_OPERATOR }] });
      expect(ctx.roleNames).toEqual([SystemRole.DESK_OPERATOR]);
    });

    it('reads roles given as plain strings', async () => {
      // The raw JWT payload carries string roles; validateJwtPayload returns entities. Both
      // shapes reach req.user depending on the path, so both must resolve.
      const ctx = await resolveFor({ organizationId: 'org-1', roles: [SystemRole.DESK_OPERATOR] });
      expect(ctx.roleNames).toEqual([SystemRole.DESK_OPERATOR]);
    });

    it('treats an unrecognised roles value as no roles rather than throwing', async () => {
      const ctx = await resolveFor({ organizationId: 'org-1', roles: 'DESK_OPERATOR' as never });
      expect(ctx.roleNames).toEqual([]);
      // Failing closed: no roles means not cross-tenant, so a malformed principal is scoped
      // rather than accidentally granted platform-wide reach.
      expect(ctx.isCrossTenant).toBe(false);
    });
  });

  describe('cross-tenant access', () => {
    /**
     * ADMIN reaches across organisations; every other role is scoped to its own.
     *
     * This used to be a distinction between two admin roles — the platform operator saw every
     * tenant, an organisation administrator saw one. They are one role now, and the platform
     * operator's reading wins, so an ADMIN is cross-tenant. That is a widening on paper; in
     * practice this deployment has a single organisation, and the role that runs the platform
     * is the role that would have to be able to see it. If a second tenant is ever added, this
     * is the first thing to revisit.
     */
    it('grants it to ADMIN, which runs the platform', async () => {
      const ctx = await resolveFor({ organizationId: 'org-1', roles: [{ name: SystemRole.ADMIN }] });
      expect(ctx.isCrossTenant).toBe(true);
    });

    it.each([SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR])(
      'withholds it from %s, which works inside one organisation',
      async (role) => {
        const ctx = await resolveFor({ organizationId: 'org-1', roles: [{ name: role }] });
        expect(ctx.isCrossTenant).toBe(false);
      },
    );

    it('withholds it from an unauthenticated request', async () => {
      const ctx = await resolveFor(undefined);
      expect(ctx.isCrossTenant).toBe(false);
      expect(ctx.organizationId).toBeNull();
    });
  });

  describe('requireOrganizationId', () => {
    it('returns the organisation when the principal has one', async () => {
      const ctx = await resolveFor({ organizationId: 'org-1', roles: [] });
      expect(ctx.requireOrganizationId()).toBe('org-1');
    });

    it('refuses rather than returning null when the principal has none', async () => {
      // Returning null would let a caller skip its WHERE clause and read every organisation —
      // the exact hole this class exists to close, reintroduced by a falsy check.
      const ctx = await resolveFor({ organizationId: null, roles: [] });
      expect(() => ctx.requireOrganizationId()).toThrow(ForbiddenException);
    });
  });
});

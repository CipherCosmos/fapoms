import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { TenantContext } from './tenant-context';
import { TenantScopedRepository, TenantOwned } from './tenant-scoped.repository';

interface Client extends TenantOwned {
  id: string;
  name: string;
  isActive?: boolean;
}

/** A concrete subclass, exposing the protected surface so it can be exercised directly. */
class ClientRepository extends TenantScopedRepository<Client> {
  protected readonly alias = 'client';
  constructor(repo: Repository<Client>, tenant: TenantContext) {
    super(repo, tenant);
  }
  query() { return this.scopedQuery(); }
  where(w?: any) { return this.scopedWhere(w); }
  owned(e: Client | null) { return this.assertOwned(e); }
  stamp(d: Partial<Client>) { return this.stampTenant(d); }
}

const tenantOf = (organizationId: string | null, crossTenant = false): TenantContext =>
  ({
    organizationId,
    isCrossTenant: crossTenant,
    requireOrganizationId() {
      if (!organizationId) throw new ForbiddenException('no organisation');
      return organizationId;
    },
  }) as unknown as TenantContext;

describe('TenantScopedRepository', () => {
  let andWhere: jest.Mock;
  let repo: Repository<Client>;

  beforeEach(() => {
    andWhere = jest.fn().mockReturnThis();
    repo = {
      createQueryBuilder: jest.fn(() => ({ andWhere })),
    } as unknown as Repository<Client>;
  });

  describe('scopedQuery', () => {
    it('constrains every builder to the caller organisation', () => {
      new ClientRepository(repo, tenantOf('org-1')).query();

      // The predicate is applied by the base class, so a subclass never holds an
      // unconstrained builder it could forget to narrow.
      expect(andWhere).toHaveBeenCalledWith(
        'client.organizationId = :__tenantId',
        { __tenantId: 'org-1' },
      );
    });

    it('leaves the builder unconstrained for the platform operator', () => {
      new ClientRepository(repo, tenantOf('org-1', true)).query();
      expect(andWhere).not.toHaveBeenCalled();
    });

    it('refuses to build a query for a principal with no organisation', () => {
      // The alternative — omitting the predicate — is an unscoped read of every tenant.
      expect(() => new ClientRepository(repo, tenantOf(null)).query()).toThrow(ForbiddenException);
    });
  });

  describe('scopedWhere', () => {
    it('adds the organisation to a single where clause', () => {
      const result = new ClientRepository(repo, tenantOf('org-1')).where({ isActive: true });
      expect(result).toEqual({ isActive: true, organizationId: 'org-1' });
    });

    it('adds the organisation to EVERY branch of an OR', () => {
      // TypeORM OR-s an array. Adding the predicate once alongside the branches would produce
      // `(a) OR (b) OR (org = :id)` — which matches the entire organisation and widens the
      // query instead of narrowing it. Array wheres are used in this codebase (AuthService.login),
      // so this is a live hazard, not a hypothetical one.
      const result = new ClientRepository(repo, tenantOf('org-1')).where([
        { name: 'Acme' },
        { id: 'client-9' },
      ]);
      expect(result).toEqual([
        { name: 'Acme', organizationId: 'org-1' },
        { id: 'client-9', organizationId: 'org-1' },
      ]);
    });

    it('scopes an absent where rather than returning an empty filter', () => {
      const result = new ClientRepository(repo, tenantOf('org-1')).where(undefined);
      expect(result).toEqual({ organizationId: 'org-1' });
    });

    it('leaves the clause untouched for the platform operator', () => {
      const result = new ClientRepository(repo, tenantOf('org-1', true)).where({ isActive: true });
      expect(result).toEqual({ isActive: true });
    });
  });

  describe('assertOwned', () => {
    const foreign: Client = { id: 'c1', name: 'Acme', organizationId: 'org-2' };

    it('accepts a row owned by the caller organisation', () => {
      const own: Client = { id: 'c1', name: 'Acme', organizationId: 'org-1' };
      expect(new ClientRepository(repo, tenantOf('org-1')).owned(own)).toBe(own);
    });

    it("refuses a row owned by another organisation", () => {
      // The update/delete shape loads by id and mutates. An id says nothing about ownership,
      // so without this a valid id from another tenant is a write into their data.
      expect(() => new ClientRepository(repo, tenantOf('org-1')).owned(foreign)).toThrow(ForbiddenException);
    });

    it('refuses a row with no owner rather than treating it as public', () => {
      const orphan: Client = { id: 'c1', name: 'Acme', organizationId: null };
      expect(() => new ClientRepository(repo, tenantOf('org-1')).owned(orphan)).toThrow(ForbiddenException);
    });

    it('reports a foreign row identically to a missing one', () => {
      const missing = () => new ClientRepository(repo, tenantOf('org-1')).owned(null);
      const other = () => new ClientRepository(repo, tenantOf('org-1')).owned(foreign);
      // Distinguishing them would confirm that a given id exists in some other organisation,
      // which is itself a disclosure.
      let missingMessage = '';
      let otherMessage = '';
      try { missing(); } catch (e) { missingMessage = (e as Error).message; }
      try { other(); } catch (e) { otherMessage = (e as Error).message; }
      expect(otherMessage).toBe(missingMessage);
    });

    it('lets the platform operator through', () => {
      expect(new ClientRepository(repo, tenantOf('org-1', true)).owned(foreign)).toBe(foreign);
    });
  });

  describe('stampTenant', () => {
    it('sets the owning organisation on a new row', () => {
      // Creates currently thread organizationId down from the controller as an optional
      // argument, so omitting it writes a null-owned row that no scoped read returns again.
      expect(new ClientRepository(repo, tenantOf('org-1')).stamp({ name: 'Acme' }))
        .toEqual({ name: 'Acme', organizationId: 'org-1' });
    });

    it('refuses to create an unowned row', () => {
      expect(() => new ClientRepository(repo, tenantOf(null)).stamp({ name: 'Acme' })).toThrow(ForbiddenException);
    });
  });
});

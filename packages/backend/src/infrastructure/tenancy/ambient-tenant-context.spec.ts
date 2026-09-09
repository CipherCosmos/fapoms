import { readFileSync } from 'fs';
import { join } from 'path';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SystemRole } from '@fapoms/shared';

import { runWithRequestContext, type RequestContext } from '../../core/context/request-context';
import {
  AmbientTenantContext,
  assertTenantOwns,
  isUnscopedCaller,
  tenantFilterId,
  tenantScope,
  tenantSql,
  tenantStampId,
  tenantWhere,
} from './ambient-tenant-context';

/** Run `fn` as if it were inside an HTTP request whose interceptor recorded `ctx`. */
const asRequest = <T>(ctx: Partial<RequestContext>, fn: () => T): T =>
  runWithRequestContext({ method: 'GET', route: '/assayers', ...ctx }, fn);

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

describe('AmbientTenantContext', () => {
  describe('tenantScope', () => {
    it('confines an ordinary principal to its own organisation', () => {
      const scope = asRequest({ organizationId: ORG_A, roleNames: [SystemRole.OPERATIONS] }, tenantScope);
      expect(scope).toEqual({ kind: 'tenant', organizationId: ORG_A });
    });

    it('does NOT treat OPERATIONS as cross-tenant', () => {
      // The role finding F-03 was reproduced with. If it ever joins `CROSS_TENANT_ROLES` the whole
      // remediation is undone in one line, and this is the assertion that notices.
      expect(asRequest({ organizationId: ORG_A, roleNames: [SystemRole.OPERATIONS] }, isUnscopedCaller))
        .toBe(false);
    });

    it.each([SystemRole.ADMIN, SystemRole.DEVELOPER])('lets %s read across organisations', (role) => {
      expect(asRequest({ organizationId: ORG_A, roleNames: [role] }, tenantScope)).toEqual({ kind: 'platform' });
    });

    it.each([
      SystemRole.AUDITOR,
      SystemRole.DESK,
      SystemRole.DESK_OPERATOR,
      SystemRole.CLIENT_USER,
      SystemRole.PRODUCT_SUPPORT,
      SystemRole.ASSAYER,
      // Not a `SystemRole` member — a role name this build does not know. An unrecognised role
      // must confine rather than widen: `TenantContext`'s comment warns about an *organisation*
      // administrator being mistaken for a platform one, and the safe reading of any name not on
      // the two-entry cross-tenant list is "one organisation".
      'ADMINISTRATOR',
    ] as string[])('confines %s to one organisation', (role) => {
      expect(asRequest({ organizationId: ORG_A, roleNames: [role] }, tenantScope))
        .toEqual({ kind: 'tenant', organizationId: ORG_A });
    });

    it('finds the cross-tenant role wherever it sits in the list', () => {
      // `RequestContext.role` records whichever entry came back first, which is why scoping reads
      // `roleNames` instead: an ADMIN whose roles happen to start with something else must not be
      // demoted to a single tenant by an accident of ordering.
      expect(asRequest(
        { organizationId: ORG_A, roleNames: [SystemRole.OPERATIONS, SystemRole.ADMIN] },
        tenantScope,
      )).toEqual({ kind: 'platform' });
    });

    it('falls back to the single primary role when roleNames is absent', () => {
      // Belt and braces for any path that fills `role` but not `roleNames` — an older cached
      // principal shape, say. Reading neither would silently make an ADMIN tenant-scoped.
      expect(asRequest({ organizationId: ORG_A, role: SystemRole.ADMIN }, tenantScope))
        .toEqual({ kind: 'platform' });
    });

    it('refuses a principal that carries no organisation', () => {
      // Not "no filter" — that is the bug this class exists to prevent. Post-backfill this can
      // only be a provisioning fault on one account, and the message says so.
      expect(() => asRequest({ roleNames: [SystemRole.OPERATIONS] }, tenantScope))
        .toThrow(ForbiddenException);
    });

    it('reports background work as unscoped rather than refusing it', () => {
      /**
       * The documented fail-open, asserted so it is a decision rather than an accident.
       *
       * A Bull job, a cron sweep or a migration has no request and therefore no principal. The
       * roster-import worker reaches `AssayerService.bulkTransitionLifecycle`, so refusing here
       * would break the path that created 1,155 of the 1,172 people on this system. The risk this
       * accepts — that a missing middleware would make every HTTP request look like background
       * work — is covered by the fitness test at the bottom of this file.
       */
      expect(tenantScope()).toEqual({ kind: 'system' });
      expect(tenantFilterId()).toBeNull();
    });
  });

  describe('tenantWhere', () => {
    it('adds the organisation to a single clause', () => {
      expect(asRequest({ organizationId: ORG_A, roleNames: [SystemRole.OPERATIONS] },
        () => tenantWhere({ id: 'a1', isActive: true })))
        .toEqual({ id: 'a1', isActive: true, organizationId: ORG_A });
    });

    it('adds the organisation to EVERY branch of an OR', () => {
      // TypeORM OR-s an array. Appending the predicate once alongside the branches would produce
      // `(code) OR (employeeId) OR (org = mine)` — the caller's whole organisation, matched by
      // membership alone, which is WIDER than the unscoped query it replaced.
      // `AssayerService.getProfile` builds exactly this array shape.
      expect(asRequest({ organizationId: ORG_A, roleNames: [SystemRole.OPERATIONS] },
        () => tenantWhere([{ assayerCode: 'AS0688' }, { employeeId: 'E1' }])))
        .toEqual([
          { assayerCode: 'AS0688', organizationId: ORG_A },
          { employeeId: 'E1', organizationId: ORG_A },
        ]);
    });

    it('leaves the clause untouched for the platform operator and for background work', () => {
      const clause = { id: 'a1' };
      expect(asRequest({ organizationId: ORG_A, roleNames: [SystemRole.ADMIN] }, () => tenantWhere(clause)))
        .toEqual(clause);
      expect(tenantWhere(clause)).toEqual(clause);
    });
  });

  describe('tenantSql', () => {
    it('appends its bind value without renumbering the caller placeholders', () => {
      // `HrWorkforceService` binds positionally and builds its own `$1…$n` first. A fragment that
      // inserted rather than appended would silently shift every existing placeholder.
      const params: unknown[] = ['IDENTITY_DOCUMENTS', 30];
      const sql = asRequest({ organizationId: ORG_A, roleNames: [SystemRole.OPERATIONS] },
        () => tenantSql('a', params));
      expect(sql).toBe(' AND a.organization_id = $3');
      expect(params).toEqual(['IDENTITY_DOCUMENTS', 30, ORG_A]);
    });

    it('emits nothing at all for an unscoped caller', () => {
      // So the statement a platform operator or a background sweep runs is byte-for-byte the one
      // that ran before tenancy existed.
      const params: unknown[] = [30];
      expect(asRequest({ organizationId: ORG_A, roleNames: [SystemRole.ADMIN] }, () => tenantSql('a', params)))
        .toBe('');
      expect(params).toEqual([30]);
    });
  });

  describe('assertTenantOwns', () => {
    const scoped = <T>(fn: () => T) =>
      asRequest({ organizationId: ORG_A, roleNames: [SystemRole.OPERATIONS] }, fn);

    it('accepts a row owned by the caller organisation', () => {
      expect(() => scoped(() => assertTenantOwns(ORG_A, 'No such document.'))).not.toThrow();
    });

    it('refuses a row owned by another organisation as a 404, not a 403', () => {
      // 403 would confirm the id names a real record somewhere on the platform — the same oracle
      // the certification used to prove the reads were genuine, merely renamed.
      expect(() => scoped(() => assertTenantOwns(ORG_B, 'No such document.')))
        .toThrow(NotFoundException);
    });

    it('reports a missing row and a foreign row with the identical message', () => {
      const messageFrom = (owner: string | null | undefined) => {
        try { scoped(() => assertTenantOwns(owner, 'No such document.')); return ''; }
        catch (e) { return (e as Error).message; }
      };
      expect(messageFrom(undefined)).toBe(messageFrom(ORG_B));
      expect(messageFrom(undefined)).toBe('No such document.');
    });

    it('refuses a row with no owner rather than treating it as public', () => {
      // A null-owned row is a backfill miss or a writer that forgot to stamp. "Unknown owner"
      // resolving to "anybody may have it" is not a defensible default for personnel data.
      expect(() => scoped(() => assertTenantOwns(null, 'No such document.'))).toThrow(NotFoundException);
    });

    it('lets the platform operator and background work through', () => {
      expect(() => asRequest({ organizationId: ORG_A, roleNames: [SystemRole.ADMIN] },
        () => assertTenantOwns(ORG_B, 'No such document.'))).not.toThrow();
      expect(() => assertTenantOwns(ORG_B, 'No such document.')).not.toThrow();
    });
  });

  describe('tenantStampId', () => {
    it('stamps the platform operator own organisation, not null', () => {
      // `tenantFilterId` is null for ADMIN because they READ across organisations. They still
      // belong to one, and a row ADMIN creates with a null organisation is invisible to every
      // scoped read from the moment it is written — the failure that never raises an error.
      expect(asRequest({ organizationId: ORG_A, roleNames: [SystemRole.ADMIN] }, tenantStampId)).toBe(ORG_A);
      expect(asRequest({ organizationId: ORG_A, roleNames: [SystemRole.ADMIN] }, tenantFilterId)).toBeNull();
    });

    it('is null outside a request, so a background writer supplies its own', () => {
      expect(tenantStampId()).toBeNull();
    });
  });

  describe('the injectable face', () => {
    const ctx = new AmbientTenantContext();

    it('satisfies the contract TenantScopedRepository reads off TenantContext', () => {
      // So a future repository can extend that base class, pass this instead of the request-scoped
      // `TenantContext`, and keep its whole injection chain a singleton.
      asRequest({ organizationId: ORG_A, roleNames: [SystemRole.OPERATIONS] }, () => {
        expect(ctx.organizationId).toBe(ORG_A);
        expect(ctx.isCrossTenant).toBe(false);
        expect(ctx.requireOrganizationId()).toBe(ORG_A);
      });
      asRequest({ organizationId: ORG_A, roleNames: [SystemRole.ADMIN] }, () => {
        expect(ctx.isCrossTenant).toBe(true);
      });
    });

    it('is a singleton with no per-request state to leak between requests', () => {
      // The bug `TenantContext` replaced `TenantContextResolver` over: a process-wide field holding
      // per-request state, visible to another request at every `await`. There is no field here —
      // two nested contexts each read their own store.
      asRequest({ organizationId: ORG_A, roleNames: [SystemRole.OPERATIONS] }, () => {
        expect(ctx.organizationId).toBe(ORG_A);
        asRequest({ organizationId: ORG_B, roleNames: [SystemRole.OPERATIONS] }, () => {
          expect(ctx.organizationId).toBe(ORG_B);
        });
        expect(ctx.organizationId).toBe(ORG_A);
      });
    });
  });

  describe('the fail-open this design accepts', () => {
    it('still has requestContextMiddleware installed in main.ts', () => {
      /**
       * The one assertion holding up the "no request means background work" branch.
       *
       * That branch applies no predicate, which is correct for a Bull job and catastrophic for an
       * HTTP request. The only thing distinguishing them is whether `requestContextMiddleware` has
       * opened the ambient store — so if that `app.use` were ever removed or reordered behind the
       * router, every request on the platform would silently become unscoped, across the whole
       * assayer module at once, with nothing failing and nothing logged.
       *
       * Read as text rather than by booting the app: this must fail on the edit that removes the
       * line, in a unit run, without a database or a port.
       */
      const main = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');
      expect(main).toContain('requestContextMiddleware');
      expect(main).toMatch(/app\.use\(\s*requestContextMiddleware\s*\)/);
    });

    it('still fills organizationId and roleNames on the ambient context', () => {
      // The other half of the same chain: the middleware opens the store before auth has run, and
      // `RequestContextInterceptor` is what puts the resolved principal's organisation into it. A
      // store with no `organizationId` refuses rather than leaks, so losing this fails closed —
      // but it fails closed for every request, which is its own outage.
      const interceptor = readFileSync(
        join(__dirname, '..', '..', 'core', 'context', 'request-context.interceptor.ts'), 'utf8',
      );
      expect(interceptor).toContain('organizationId');
      expect(interceptor).toContain('roleNames');
    });
  });
});

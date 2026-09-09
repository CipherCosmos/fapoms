import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { NotificationTenancyService, TenancyLookupInput } from './notification-tenancy';

/**
 * The decision ladder in `NotificationTenancyService.resolve` — which organisation a notification
 * is stamped with, and on what authority.
 *
 * ## Why this file, when `notification-tenant-isolation.db.spec.ts` exists
 *
 * That file proves the SQL. It runs every statement in `ENTITY_ORGANIZATION_SQL` against the live
 * schema and walks two real tenants end to end, which is the only way to catch a column rename —
 * and it needs a live, genuinely multi-tenant database to do it, so it is a `.db.spec.ts` and CI
 * never runs it. What it does not test, and structurally cannot test cheaply, is the ladder ABOVE
 * the SQL: the order the candidates are tried in, which identifiers are rejected before a query is
 * ever issued, when the single-tenant shortcut is allowed to answer, and what happens when a lookup
 * throws. Coverage said so out loud — `notification-tenancy.ts` sat at 15.25% of statements with
 * 0% of branches and 0% of functions, and `notification-dispatch.service.spec.ts` stubs this
 * service wholesale, so nothing in the unit run touched a single decision in it.
 *
 * That is a bad thing to leave untested, because both directions of a wrong answer are silent.
 * Resolve too generously and finding F-07 comes back: an OPERATIONS user reads another
 * organisation's assayer name out of their notification bell. Resolve too strictly and the type
 * quietly stops being delivered to anybody — no error reaches a user, and the only trace is a warn
 * line. There is no failure mode here that announces itself, which is exactly why the branches need
 * pinning rather than eyeballing.
 *
 * ## What is mocked, and why that is honest here
 *
 * Only `dataSource.query`. Every assertion below is about a decision this class makes on its own —
 * what it asks for, in what order, and what it concludes — so a stub that records the statements it
 * was handed is the whole environment the ladder needs. The one thing a stub could hide is a
 * statement that does not match the schema, and that is precisely what the db spec is for.
 */

const ORG_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ASSAYER_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
const ASSIGNMENT_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
const BRANCH_ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

describe('NotificationTenancyService.resolve', () => {
  let service: NotificationTenancyService;
  /** Every statement the service issued, in order, with its parameters. */
  let issued: Array<{ sql: string; params: any[] }>;
  let query: jest.Mock;

  /**
   * Answers the entity lookups from a table of id → organisation, and the organisation count from
   * an explicit list. Keyed by id rather than by statement because the statements are the db spec's
   * business; what this file cares about is which id was asked about and when.
   */
  const serve = (opts: { owners?: Record<string, string | null>; activeOrgs?: string[] }) => {
    const owners = opts.owners ?? {};
    const activeOrgs = opts.activeOrgs ?? [];
    query.mockImplementation(async (sql: string, params?: any[]) => {
      issued.push({ sql, params: params ?? [] });
      if (sql.includes('FROM organizations')) return activeOrgs.map((id) => ({ id }));
      const id = params?.[0];
      const org = owners[id as string];
      // A miss is an empty result set, not a row of nulls — that is what Postgres returns for a
      // `WHERE id = $1` that matches nothing, and the two are read differently by `lookup`.
      return org === undefined ? [] : [{ org }];
    });
  };

  /** A fresh service per test: this class caches, and a shared instance would leak answers between them. */
  const build = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationTenancyService,
        { provide: getDataSourceToken(), useValue: { query } },
      ],
    }).compile();
    return module.get(NotificationTenancyService);
  };

  beforeEach(async () => {
    issued = [];
    query = jest.fn();
    service = await build();
  });

  const input = (over: Partial<TenancyLookupInput> = {}): TenancyLookupInput => ({
    type: 'ASSAYER_ONBOARDED',
    ...over,
  });

  describe('a platform-scoped type', () => {
    it('is exempt without a single query being issued', async () => {
      serve({ activeOrgs: [ORG_A] });

      const result = await service.resolve(
        input({ entityType: 'ASSAYER', entityId: ASSAYER_ID }),
        'PLATFORM',
      );

      expect(result).toEqual({
        scope: 'PLATFORM',
        organizationId: null,
        source: 'PLATFORM',
        attempted: [],
      });
      // The short-circuit is the point: a platform type carries no tenant, so looking one up would
      // be both wasted work and a way for a stray entity id to attach an organisation to a row
      // that is meant to have none.
      expect(issued).toHaveLength(0);
    });
  });

  describe('an organisation the caller supplied outright', () => {
    it('is taken at its word, without a lookup', async () => {
      serve({ owners: { [ASSAYER_ID]: ORG_B } });

      const result = await service.resolve(
        input({ organizationId: ORG_A, entityType: 'ASSAYER', entityId: ASSAYER_ID }),
        'TENANT',
      );

      expect(result.organizationId).toBe(ORG_A);
      expect(result.source).toBe('EXPLICIT');
      expect(issued).toHaveLength(0);
    });

    /**
     * The uuid test on the explicit branch is load-bearing and easy to read past.
     *
     * `EmitOptions.organizationId` is a plain optional string on a fire-and-forget call, so a call
     * site that reaches for the wrong variable passes something like a client code or an empty
     * string rather than failing. Trusted, that value is written to `notifications.organization_id`
     * and then used by the read side as a tenant boundary — a boundary made of a typo. Rejecting it
     * costs nothing, because the entity ladder below is a better answer anyway.
     */
    it('is ignored when it is not a uuid, and the entity is consulted instead', async () => {
      serve({ owners: { [ASSAYER_ID]: ORG_B } });

      const result = await service.resolve(
        input({ organizationId: 'FAPOMS', entityType: 'ASSAYER', entityId: ASSAYER_ID }),
        'TENANT',
      );

      expect(result.organizationId).toBe(ORG_B);
      expect(result.source).toBe('ENTITY');
    });
  });

  describe('deriving the organisation from the event’s own subject', () => {
    it('asks about the declared entity before anything in the payload', async () => {
      serve({ owners: { [ASSIGNMENT_ID]: ORG_A, [ASSAYER_ID]: ORG_B } });

      const result = await service.resolve(
        input({
          entityType: 'ASSIGNMENT',
          entityId: ASSIGNMENT_ID,
          assayerId: ASSAYER_ID,
        }),
        'TENANT',
      );

      // Both would have answered. The declared entity is the event's actual subject, so it wins,
      // and the assayer is never even asked — order here is a correctness property, not a
      // performance one, for any event whose subject and whose assayer belong to different orgs.
      expect(result.organizationId).toBe(ORG_A);
      expect(issued.map((q) => q.params[0])).toEqual([ASSIGNMENT_ID]);
    });

    it('falls through to the next candidate when the first names no organisation', async () => {
      serve({ owners: { [ASSIGNMENT_ID]: null, [ASSAYER_ID]: ORG_B } });

      const result = await service.resolve(
        input({ entityType: 'ASSIGNMENT', entityId: ASSIGNMENT_ID, assayerId: ASSAYER_ID }),
        'TENANT',
      );

      // A row that exists but carries a null `organization_id` is a legacy row the backfill did not
      // reach. It is not an answer, and it must not stop the search.
      expect(result.organizationId).toBe(ORG_B);
      expect(result.source).toBe('ENTITY');
      expect(issued.map((q) => q.params[0])).toEqual([ASSIGNMENT_ID, ASSAYER_ID]);
    });

    it('reaches ids that only the payload carries', async () => {
      serve({ owners: { [BRANCH_ID]: ORG_A } });

      const result = await service.resolve(
        input({ entityType: 'DOCUMENT', entityId: null, payload: { branchId: BRANCH_ID } }),
        'TENANT',
      );

      // The redundancy that lets ~50 `emitSafe` call sites stay untouched: the declared entity had
      // no id, but the event still carried something that names a tenant.
      expect(result.organizationId).toBe(ORG_A);
      expect(result.source).toBe('ENTITY');
    });

    /**
     * `SlaScannerWorker` emits `PAYABLE_AWAITING_APPROVAL` with `entityId: 'backlog'` — the event is
     * a count across many records, so there is no entity to look up. Passed to Postgres against a
     * `uuid` column that is not a syntax error the planner catches, it is a runtime
     * `invalid input syntax for type uuid`, one warn line per sweep, and a lookup that answers null
     * anyway. The regex exists to keep that query from ever being issued.
     */
    it('never issues a query for a placeholder id that is not a uuid', async () => {
      serve({ activeOrgs: [ORG_A, ORG_B] });

      const result = await service.resolve(
        input({ type: 'PAYABLE_AWAITING_APPROVAL', entityType: 'PAYABLE', entityId: 'backlog' }),
        'TENANT',
      );

      expect(issued.filter((q) => !q.sql.includes('FROM organizations'))).toHaveLength(0);
      expect(result.source).toBe('UNRESOLVED');
      expect(result.attempted).toEqual([]);
    });

    it('skips an entity type it has no lookup for, rather than throwing', async () => {
      serve({ activeOrgs: [ORG_A, ORG_B] });

      const result = await service.resolve(
        input({ entityType: 'SOMETHING_NEW', entityId: ASSAYER_ID }),
        'TENANT',
      );

      // A new `entityType` added to a catalog entry without a row in `ENTITY_ORGANIZATION_SQL` must
      // degrade to "cannot tell" — which fails closed — and not take the emitting business
      // transaction down with it.
      expect(result.source).toBe('UNRESOLVED');
      expect(issued.filter((q) => !q.sql.includes('FROM organizations'))).toHaveLength(0);
    });

    /**
     * `attempted` is not decoration. It is the only thing in the error log that tells an operator
     * WHICH identifier failed to resolve, and a type that has silently stopped being delivered is
     * diagnosed from that list or not at all.
     */
    it('names every identifier it tried when it ends up refusing', async () => {
      serve({ owners: { [ASSIGNMENT_ID]: null, [ASSAYER_ID]: null }, activeOrgs: [ORG_A, ORG_B] });

      const result = await service.resolve(
        input({ entityType: 'ASSIGNMENT', entityId: ASSIGNMENT_ID, assayerId: ASSAYER_ID }),
        'TENANT',
      );

      expect(result.source).toBe('UNRESOLVED');
      expect(result.attempted).toEqual([`ASSIGNMENT:${ASSIGNMENT_ID}`, `ASSAYER:${ASSAYER_ID}`]);
    });
  });

  describe('the single-tenant shortcut', () => {
    it('answers when the deployment has exactly one active organisation', async () => {
      serve({ owners: { [ASSAYER_ID]: null }, activeOrgs: [ORG_A] });

      const result = await service.resolve(input({ assayerId: ASSAYER_ID }), 'TENANT');

      expect(result.organizationId).toBe(ORG_A);
      expect(result.source).toBe('SOLE_TENANT');
    });

    /**
     * The whole safety argument for `SOLE_TENANT` is "with one organisation there is no second
     * tenant to leak to". The moment there are two, the argument evaporates, and this must go back
     * to refusing — without a deploy, which is the property being pinned here.
     */
    it('refuses instead, the moment a second organisation exists', async () => {
      serve({ owners: { [ASSAYER_ID]: null }, activeOrgs: [ORG_A, ORG_B] });

      const result = await service.resolve(input({ assayerId: ASSAYER_ID }), 'TENANT');

      expect(result.organizationId).toBeNull();
      expect(result.source).toBe('UNRESOLVED');
    });

    it('refuses when there are no organisations at all', async () => {
      serve({ activeOrgs: [] });

      const result = await service.resolve(input({ assayerId: ASSAYER_ID }), 'TENANT');

      expect(result.source).toBe('UNRESOLVED');
    });
  });

  describe('when the database will not answer', () => {
    it('treats an entity lookup that throws as “unknown”, not as an error to raise', async () => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM organizations')) return [{ id: ORG_A }];
        throw new Error('deadlock detected');
      });

      // `emit` runs inside business transactions and is deliberately fire-and-forget. A lookup that
      // threw through it would roll back the assayer activation that triggered the notification —
      // the notification failing must never cost the business action.
      const result = await service.resolve(input({ assayerId: ASSAYER_ID }), 'TENANT');

      expect(result.organizationId).toBe(ORG_A);
      expect(result.source).toBe('SOLE_TENANT');
    });

    /**
     * An unreadable `organizations` table must not become a licence to fan out. `rows?.length === 1`
     * is the only shape that means "one tenant"; a throw means "no idea", and no idea fails closed.
     */
    it('does not treat an unreadable organisations table as a single tenant', async () => {
      query.mockRejectedValue(new Error('connection terminated'));

      const result = await service.resolve(input({ assayerId: ASSAYER_ID }), 'TENANT');

      expect(result.organizationId).toBeNull();
      expect(result.source).toBe('UNRESOLVED');
    });

    it('does not cache a failed organisation count, so the next event tries again', async () => {
      let attempt = 0;
      query.mockImplementation(async (sql: string) => {
        if (!sql.includes('FROM organizations')) return [];
        attempt += 1;
        if (attempt === 1) throw new Error('connection terminated');
        return [{ id: ORG_A }];
      });

      const first = await service.resolve(input({ assayerId: ASSAYER_ID }), 'TENANT');
      const second = await service.resolve(input({ assayerId: ASSAYER_ID }), 'TENANT');

      // Caching the failure would strand every TENANT-scoped notification for a full cache TTL
      // after one transient blip — a five-figure count of undelivered rows on a busy deployment.
      expect(first.source).toBe('UNRESOLVED');
      expect(second.source).toBe('SOLE_TENANT');
      expect(second.organizationId).toBe(ORG_A);
    });
  });

  describe('caching', () => {
    /**
     * Bulk activation emits one notification per assayer and the roster import emits them in
     * hundreds. Without the cache that is one round trip per row per recipient-resolution, against a
     * table the emitting transaction is frequently already holding locks on.
     */
    it('asks about the same entity once across a burst', async () => {
      serve({ owners: { [ASSAYER_ID]: ORG_A } });

      for (let i = 0; i < 25; i += 1) {
        await service.resolve(input({ assayerId: ASSAYER_ID }), 'TENANT');
      }

      expect(issued).toHaveLength(1);
    });

    it('caches a miss too, so a legacy row with no organisation is not re-queried 25 times', async () => {
      serve({ owners: { [ASSAYER_ID]: null }, activeOrgs: [ORG_A] });

      await service.resolve(input({ assayerId: ASSAYER_ID }), 'TENANT');
      await service.resolve(input({ assayerId: ASSAYER_ID }), 'TENANT');

      expect(issued.filter((q) => q.params[0] === ASSAYER_ID)).toHaveLength(1);
    });

    it('keeps two entities apart', async () => {
      serve({ owners: { [ASSAYER_ID]: ORG_A, [BRANCH_ID]: ORG_B } });

      const a = await service.resolve(input({ assayerId: ASSAYER_ID }), 'TENANT');
      const b = await service.resolve(
        input({ entityType: 'BRANCH', entityId: BRANCH_ID }),
        'TENANT',
      );

      expect([a.organizationId, b.organizationId]).toEqual([ORG_A, ORG_B]);
    });
  });

  describe('the lookup map itself', () => {
    it('exposes a statement for every kind the resolver can reach for', async () => {
      // `resolve` builds its candidate list from hard-coded kind names. One renamed key in
      // `ENTITY_ORGANIZATION_SQL` and the matching candidate silently stops being tried — no throw,
      // no warn, just a type that resolves one rung further down the ladder than it should.
      const reachable = [
        'ASSAYER', 'ASSIGNMENT', 'SCHEDULE', 'PROJECT_BRANCH', 'BRANCH', 'PROJECT', 'CLIENT',
      ];
      const kinds = NotificationTenancyService.entityLookupKinds();

      for (const kind of reachable) {
        expect(kinds).toContain(kind);
        expect(NotificationTenancyService.entityLookupSql(kind)).toContain('$1');
      }
    });
  });
});

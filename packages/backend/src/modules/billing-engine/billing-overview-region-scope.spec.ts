import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { BillingEngineService } from './billing-engine.service';
import { BillingEngineController } from './billing-engine.controller';
import { resolveGlobalScope } from '../../infrastructure/scope/global-scope';
import {
  assignmentInRegion,
  invoiceInRegion,
  paymentInRegion,
  billingRegionFilters,
} from './billing-region-scope';
import { Region } from '@fapoms/shared';

/**
 * `GET /billing-engine/overview` returned the whole organisation's book to a region-assigned
 * account.
 *
 * Every other read on the billing controller took `@GlobalScopeFilter()`; `overview()` took no
 * parameters at all, so `users.regions` never reached the eight aggregate queries behind it.
 * Reproduced live on 2026-09-09 against the deployed build: a NORTH-only OPERATIONS account
 * (`fos_ops_north`) received a payload byte-for-byte identical to ADMIN's — EAST revenue, EAST
 * outstanding, EAST cash and other clients' names included — while `GET /billing-engine/payouts`
 * for the same token correctly returned 4 rows out of 23.
 *
 * This file is the structural half of the fix's coverage: it drives the real `overview()` against
 * a recording manager and asserts, per query, that the predicate is there. It is a unit test on
 * purpose — the numeric reconciliation needs real rows and lives in the `.db.spec.ts` beside it,
 * which is held out of the CI unit run. Delete the region predicate from any ONE of the eight and
 * exactly one case here goes red, naming it.
 *
 * The three cases that are NOT "does it filter" matter just as much:
 *   - an unrestricted (national) caller must reach the ORIGINAL unfiltered SQL, with no predicate
 *     and no bound parameter, in every mode;
 *   - `log` mode must leave the figures national and only report;
 *   - `off` mode must not even count.
 * A fix that quietly narrowed the national view would be a worse defect than the leak.
 */

/** Fragments that only appear when a region predicate has been spliced in. */
const REGION_MARKERS = ['rgn_a', 'rgi_e', 'rgx_e', 'rgm_p', 'rgm_i'];
const carriesRegionPredicate = (sql: string) => REGION_MARKERS.some((m) => sql.includes(m));

interface Recorded {
  sql: string;
  params: unknown[] | undefined;
}

/**
 * `overview()` reads through `entryRepository.manager` and `historyRepository`, and nothing else
 * — so the whole method can be driven with two doubles and the real region guard contract.
 */
function harness(mode: 'off' | 'log' | 'enforce') {
  const calls: Recorded[] = [];
  const manager = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return [{}];
    }),
  };
  const historyFind = jest.fn(async () => []);
  const entryRepository: any = { manager };
  const historyRepository: any = { manager, find: historyFind };
  const regionGuard: any = { stagedMode: jest.fn(async () => mode) };
  const nil: any = undefined;
  const service = new BillingEngineService(
    entryRepository, nil, nil, nil, historyRepository,
    nil, nil, nil, nil, regionGuard, nil, nil, nil, nil, nil,
  );
  return { service, calls, historyFind };
}

/**
 * The eight slots of the `Promise.all` in `overview()`, each identified by a string that appears
 * only in that statement. `history` is matched on the raw form the scoped path uses; the
 * unrestricted path goes through the repository instead and is asserted separately.
 */
const QUERIES: Array<{ slot: string; find: string; source: string }> = [
  { slot: '1 payouts',      find: 'AS tds_from_assayers',   source: 'assayer_payables' },
  { slot: '2 client lines', find: 'AS tds_by_clients',      source: 'billing_entries' },
  { slot: '3 invoices',     find: 'AS collected',           source: 'billing_invoices' },
  { slot: '4 ageing',       find: 'AS d90_plus',            source: 'billing_invoices' },
  { slot: '5 cashflow',     find: 'AS cash_out',            source: 'billing_payments' },
  { slot: '6 by client',    find: 'AS client_rate',         source: 'clients + all three' },
  { slot: '7 recent',       find: 'FROM billing_history',   source: 'billing_history' },
  { slot: '8a unbooked',    find: "a.status = 'COMPLETED'", source: 'assignments' },
  { slot: '8b unsettled',   find: "->>'settled') = 'false'", source: 'assayer_payables' },
  { slot: '8c fee changed', find: 'AS booked_fee',          source: 'assayer_payables' },
  { slot: '8d held payout', find: 'p.on_hold = true',       source: 'assayer_payables' },
  { slot: '8e held line',   find: 'e.on_hold = true',       source: 'billing_entries' },
  { slot: '8f overdue',     find: 'AS days_overdue',        source: 'billing_invoices' },
];

const NORTH_ONLY = { regions: [Region.NORTH] };

describe('GET /billing-engine/overview is region scoped', () => {
  describe('enforce mode, a caller assigned to one region', () => {
    let calls: Recorded[];

    beforeAll(async () => {
      const h = harness('enforce');
      await h.service.overview(NORTH_ONLY);
      calls = h.calls;
    });

    it('runs every one of the thirteen statements the eight slots are made of', () => {
      for (const { slot, find } of QUERIES) {
        expect(calls.filter((c) => c.sql.includes(find)).length).toBeGreaterThanOrEqual(1);
        expect(slot).toBeTruthy();
      }
    });

    it.each(QUERIES)('$slot ($source) carries a region predicate', ({ find }) => {
      const matched = calls.filter((c) => c.sql.includes(find));
      expect(matched.length).toBeGreaterThan(0);
      for (const c of matched) expect(carriesRegionPredicate(c.sql)).toBe(true);
    });

    it.each(QUERIES)('$slot binds the caller regions as a parameter, never inlined', ({ find }) => {
      for (const c of calls.filter((x) => x.sql.includes(find))) {
        expect(c.params).toEqual([[Region.NORTH]]);
        expect(c.sql).toContain('$1::text[]');
        // The region name itself must never reach the SQL text.
        expect(c.sql).not.toContain(`'${Region.NORTH}'`);
      }
    });

    it('reaches a region only through assignments -> project_branches -> branches', () => {
      for (const c of calls.filter((x) => carriesRegionPredicate(x.sql))) {
        expect(c.sql).toMatch(/JOIN project_branches \w+ ON \w+\.id = \w+\.project_branch_id/);
        expect(c.sql).toMatch(/JOIN branches \w+ ON \w+\.id = \w+\.branch_id/);
      }
    });

    it('scopes an invoice by its lines, both halves — has one of mine, has none of anyone else\'s', () => {
      const invoiceQueries = calls.filter((c) => c.sql.includes('AS collected') || c.sql.includes('AS d90_plus'));
      expect(invoiceQueries).toHaveLength(2);
      for (const c of invoiceQueries) {
        expect(c.sql).toContain('rgi_e.invoice_id');   // at least one in-scope line
        expect(c.sql).toContain('NOT EXISTS');          // and no out-of-scope line
        expect(c.sql).toContain('rgx_b.region IS NOT NULL');
      }
    });

    it('scopes a payment through whichever row it settles, not through a rule of its own', () => {
      const cash = calls.find((c) => c.sql.includes('AS cash_out'))!;
      expect(cash.sql).toContain('assayer_payables rgm_p');
      expect(cash.sql).toContain('billing_invoices rgm_i');
    });

    it('reads the history through the scoped raw query, not the unfiltered repository call', async () => {
      const h = harness('enforce');
      await h.service.overview(NORTH_ONLY);
      expect(h.historyFind).not.toHaveBeenCalled();
      expect(h.calls.some((c) => c.sql.includes('FROM billing_history'))).toBe(true);
    });
  });

  describe('a caller with no region assignment keeps the national view', () => {
    it.each(['off', 'log', 'enforce'] as const)('%s mode: no predicate, no parameter', async (mode) => {
      const h = harness(mode);
      await h.service.overview({ regions: null });
      expect(h.calls.length).toBeGreaterThan(0);
      for (const c of h.calls) {
        expect(carriesRegionPredicate(c.sql)).toBe(false);
        expect(c.params ?? []).toEqual([]);
      }
      expect(h.historyFind).toHaveBeenCalledTimes(1);
    });

    it('an absent scope argument behaves exactly like an unrestricted one', async () => {
      const withNull = harness('enforce');
      await withNull.service.overview({ regions: null });
      const withNothing = harness('enforce');
      await withNothing.service.overview();
      expect(withNothing.calls.map((c) => c.sql)).toEqual(withNull.calls.map((c) => c.sql));
    });

    it('an empty region list is unrestricted, not "no regions at all"', async () => {
      const h = harness('enforce');
      await h.service.overview({ regions: [] });
      for (const c of h.calls) expect(carriesRegionPredicate(c.sql)).toBe(false);
    });
  });

  describe('the staged rollout modes', () => {
    it('log mode leaves every figure national and only reports what enforce would drop', async () => {
      const h = harness('log');
      await h.service.overview(NORTH_ONLY);
      const aggregates = h.calls.filter((c) => !c.sql.includes('AS payables,'));
      for (const c of aggregates) {
        expect(carriesRegionPredicate(c.sql)).toBe(false);
        expect(c.params ?? []).toEqual([]);
      }
      const report = h.calls.filter((c) => c.sql.includes('AS payables,'));
      expect(report).toHaveLength(1);
      expect(report[0].params).toEqual([[Region.NORTH]]);
      expect(report[0].sql).toContain('AS history');
    });

    it('off mode does not filter and does not even count', async () => {
      const h = harness('off');
      await h.service.overview(NORTH_ONLY);
      for (const c of h.calls) expect(carriesRegionPredicate(c.sql)).toBe(false);
      expect(h.calls.some((c) => c.sql.includes('AS payables,'))).toBe(false);
    });

    it('enforce mode narrows', async () => {
      const h = harness('enforce');
      await h.service.overview(NORTH_ONLY);
      expect(h.calls.every((c) => carriesRegionPredicate(c.sql))).toBe(true);
    });
  });

  describe('several regions', () => {
    it('binds the whole assignment, so a two-region account sees both', async () => {
      const h = harness('enforce');
      await h.service.overview({ regions: [Region.NORTH, Region.EAST] });
      for (const c of h.calls) expect(c.params).toEqual([[Region.NORTH, Region.EAST]]);
    });
  });
});

/**
 * The rule itself, checked once rather than re-derived at each call site: an unattributable row
 * is excluded, and an invoice must both have an in-scope line and have no out-of-scope one.
 */
describe('the region attribution rule', () => {
  it('an unattributable row cannot satisfy the assignment predicate', () => {
    const sql = assignmentInRegion('p.assignment_id');
    // INNER JOINs: an assignment with no project_branch_id, or a branch with a null region,
    // produces no row inside the EXISTS, so the predicate is false rather than true.
    expect(sql).toContain('JOIN project_branches');
    expect(sql).not.toContain('LEFT JOIN');
    expect(sql).toContain('rgn_b.region = ANY($1::text[])');
  });

  it('an invoice needs an in-scope line AND no out-of-scope line', () => {
    const sql = invoiceInRegion('i.id');
    const [inScope, outOfScope] = sql.split('AND NOT EXISTS');
    expect(inScope).toContain('rgi_b.region = ANY($1::text[])');
    expect(outOfScope).toContain('NOT (rgx_b.region = ANY($1::text[]))');
  });

  it('a payment with neither a payable nor an invoice is attributable to nobody', () => {
    const sql = paymentInRegion('pm');
    expect(sql).toContain('rgm_p.id = pm.payable_id');
    expect(sql).toContain('rgm_i.id = pm.invoice_id');
    // Two EXISTS joined by OR: neither can be satisfied by a null id, so the row is excluded.
    expect(sql.startsWith('(EXISTS')).toBe(true);
    expect(sql).toContain('OR EXISTS');
  });

  it('never inlines a region name into SQL', () => {
    const f = billingRegionFilters([Region.NORTH, Region.WEST]);
    const all = [f.payable('p'), f.entry('e'), f.invoice('i'), f.payment('pm'), f.history('h'), f.assignment('a')].join('\n');
    expect(all).not.toMatch(/NORTH|WEST/);
    expect(all.split('$1::text[]').length - 1).toBeGreaterThan(5);
  });

  it('is inert for an unrestricted caller, down to the table alias', () => {
    const f = billingRegionFilters(null);
    expect([f.as('p'), f.payable('p'), f.entry('e'), f.invoice('i'), f.payment('pm'), f.history('h'), f.assignment('a')])
      .toEqual(['', '', '', '', '', '', '']);
    expect(f.active).toBe(false);
  });
});

/**
 * The controller half. The service cannot narrow what it is never told, so the decorator being on
 * the route is as load-bearing as the SQL — and it is the piece a refactor drops silently, because
 * removing a parameter from a handler compiles and every test that calls the method directly keeps
 * passing.
 */
describe('the overview route resolves the caller scope server-side', () => {
  /** The `@GlobalScopeFilter()` factory Nest will actually run for `overview`. */
  const scopeFactory = () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, BillingEngineController, 'overview') ?? {};
    const custom = Object.values(args).find((a: any) => typeof a?.factory === 'function') as any;
    return custom?.factory as ((data: unknown, ctx: any) => any) | undefined;
  };

  const ctx = (query: Record<string, unknown>, user: unknown) => ({
    switchToHttp: () => ({ getRequest: () => ({ query, user }) }),
  });

  it('binds a scope parameter on the route at all', () => {
    expect(scopeFactory()).toBeDefined();
  });

  it('passes what the decorator resolved straight to the service', async () => {
    const overview = jest.fn(async () => ({ currency: 'INR' }));
    const controller = new BillingEngineController({ overview } as any, {} as any, {} as any, {} as any);
    const scope: any = { regions: [Region.NORTH] };
    await controller.overview(scope);
    expect(overview).toHaveBeenCalledWith(scope);
  });

  it('reads the region off the principal when the query string asks for nothing', () => {
    const scope = scopeFactory()!(undefined, ctx({}, { regions: ['NORTH'] }));
    expect(scope.regions).toEqual([Region.NORTH]);
  });

  it('refuses ?region= naming a region the account does not hold', () => {
    expect(() => scopeFactory()!(undefined, ctx({ region: 'EAST' }, { regions: ['NORTH'] })))
      .toThrow(ForbiddenException);
  });

  it('lets ?region= narrow within the assignment, never widen it', () => {
    const narrowed = scopeFactory()!(undefined, ctx({ region: 'NORTH' }, { regions: ['NORTH', 'EAST'] }));
    expect(narrowed.regions).toEqual([Region.NORTH]);
    const widened = scopeFactory()!(undefined, ctx({ region: 'ALL' }, { regions: ['NORTH'] }));
    expect(widened.regions).toEqual([Region.NORTH]);
  });

  it('ignores parameters this system does not have rather than honouring them', () => {
    // `?organizationId=` and `?scope=` are not part of the global scope: FAPOMS is a
    // single-organisation product and the scope is resolved from the principal, never named by
    // the caller. Sending them must change nothing about the ceiling.
    const scope = resolveGlobalScope(
      { organizationId: '382c3718-89e5-41a2-ac29-ab5ec7900562', scope: 'all', regions: 'EAST' },
      { regions: ['NORTH'] },
    );
    expect(scope.regions).toEqual([Region.NORTH]);
    expect(scope).not.toHaveProperty('organizationId');
  });

  it('leaves a national account national however the query string is dressed up', () => {
    const scope = resolveGlobalScope({ organizationId: 'x', scope: 'all' }, { regions: null });
    expect(scope.regions).toBeNull();
  });
});

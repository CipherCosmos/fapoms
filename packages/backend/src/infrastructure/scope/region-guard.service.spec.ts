import { ForbiddenException } from '@nestjs/common';
import { Region } from '@fapoms/shared';
import { RegionGuardService } from './region-guard.service';

/**
 * The region ceiling on single-record reads.
 *
 * These cases exist because the list-scoping and the detail-route ceiling are two separate
 * mechanisms, and an adversarial review found six detail routes where only the first had been
 * applied. A scoped list is discovery control; this is access control.
 */
describe('RegionGuardService', () => {
  const dataSource = { query: jest.fn() };
  // This mock returns 'log' so the cases below can assert the log-mode behaviour (warn, allow)
  // explicitly. NOTE: the setting's *shipped* default is now 'enforce' (see
  // settings/security-defaults.spec.ts) — 'log' here is a deliberate per-test choice, not the
  // default a fresh deployment runs under. Cases that care about enforce/off set the mode themselves.
  const mockSettings = { get: jest.fn().mockResolvedValue('log') };
  const guard = new RegionGuardService(dataSource as any, mockSettings as any);

  const west = { regions: [Region.WEST] };
  const national = { regions: null as any };

  beforeEach(() => dataSource.query.mockReset());

  describe('assertRegionAllowed', () => {
    it('allows anything when the account holds no assignment', () => {
      expect(() => guard.assertRegionAllowed(Region.SOUTH, national)).not.toThrow();
      expect(() => guard.assertRegionAllowed(Region.SOUTH, undefined)).not.toThrow();
      expect(() => guard.assertRegionAllowed(Region.SOUTH, { regions: [] })).not.toThrow();
    });

    it('allows a record inside the assignment', () => {
      expect(() => guard.assertRegionAllowed(Region.WEST, west)).not.toThrow();
    });

    it('refuses a record outside the assignment', () => {
      expect(() => guard.assertRegionAllowed(Region.SOUTH, west)).toThrow(ForbiddenException);
    });

    // A branch whose region could not be resolved must stay visible, or it becomes
    // permanently unfixable — only a scoped operator ever looks at it.
    it('allows a record with no region rather than hiding it forever', () => {
      expect(() => guard.assertRegionAllowed(null, west)).not.toThrow();
    });
  });

  describe('per-entity lookups', () => {
    it('refuses a branch in another region', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.SOUTH }]);
      await expect(guard.assertBranchInScope('b1', west)).rejects.toThrow(ForbiddenException);
    });

    it('allows a branch in the held region', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.WEST }]);
      await expect(guard.assertBranchInScope('b1', west)).resolves.toBeUndefined();
    });

    // Skipping the query entirely for national accounts keeps the ceiling off the hot path
    // for the desks it does not apply to.
    it('does not query at all for an unassigned account', async () => {
      await guard.assertBranchInScope('b1', national);
      await guard.assertAssignmentInScope('a1', national);
      await guard.assertScheduleInScope('s1', national);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('walks assignment -> project_branch -> branch', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.SOUTH }]);
      await expect(guard.assertAssignmentInScope('a1', west)).rejects.toThrow(ForbiddenException);
      expect(dataSource.query.mock.calls[0][0]).toContain('project_branches');
    });

    it('walks schedule -> assignment -> project_branch -> branch', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.SOUTH }]);
      await expect(guard.assertScheduleInScope('s1', west)).rejects.toThrow(ForbiddenException);
      expect(dataSource.query.mock.calls[0][0]).toContain('schedules');
    });

    // `GET /assayers/:assayerId/profile` accepts either form; comparing a code against a uuid
    // column raises `invalid input syntax` rather than refusing cleanly.
    it('looks an assayer up by id when given a UUID', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.WEST }]);
      await guard.assertAssayerInScope('3f2504e0-4f89-41d3-9a0c-0305e82c3301', west);
      expect(dataSource.query.mock.calls[0][0]).toContain('id = $1');
    });

    it('looks an assayer up by code when given a non-UUID', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.WEST }]);
      await guard.assertAssayerInScope('ASY-0042', west);
      expect(dataSource.query.mock.calls[0][0]).toContain('assayer_code = $1');
    });

    it('tolerates a missing record without throwing a lookup error', async () => {
      dataSource.query.mockResolvedValue([]);
      await expect(guard.assertBranchInScope('nope', west)).resolves.toBeUndefined();
    });
  });

  /**
   * The assayer's child rows.
   *
   * Sixteen routes on `assayer.controller.ts` were keyed on one of these ids — a commercial
   * profile, a KYC document, an empanelment, a workforce attribute, a score override, a
   * reference, an import issue — and had no ceiling at all, because there was no method here
   * that took such an id. Each walks child → assayer → `assayers.region`, and the table named in
   * the SQL is asserted rather than only the outcome: all seven have the same body, so a
   * copy-paste that left the wrong table behind would resolve the wrong person's region and
   * still pass a test that checked only for a 403.
   */
  describe('assayer child-row lookups', () => {
    const cases: Array<[string, keyof RegionGuardService, string]> = [
      ['commercial profile', 'assertCommercialProfileInScope', 'assayer_commercial_profiles'],
      ['identity document', 'assertAssayerDocumentInScope', 'assayer_documents'],
      ['client empanelment', 'assertEmpanelmentInScope', 'assayer_client_empanelments'],
      ['workforce attribute', 'assertWorkforceAttributeInScope', 'workforce_attributes'],
      ['qualification-score override', 'assertScoreOverrideInScope', 'assayer_score_overrides'],
      ['background-check reference', 'assertAssayerReferenceInScope', 'assayer_references'],
      ['roster import issue', 'assertImportIssueInScope', 'assayer_import_issues'],
    ];

    it.each(cases)('refuses a %s whose assayer is in another region', async (_label, method, table) => {
      dataSource.query.mockResolvedValue([{ region: Region.SOUTH }]);
      await expect((guard as any)[method]('child-1', west)).rejects.toThrow(ForbiddenException);
      expect(dataSource.query.mock.calls[0][0]).toContain(table);
      expect(dataSource.query.mock.calls[0][0]).toContain('assayers');
    });

    it.each(cases)('allows a %s whose assayer is in the held region', async (_label, method) => {
      dataSource.query.mockResolvedValue([{ region: Region.WEST }]);
      await expect((guard as any)[method]('child-1', west)).resolves.toBeUndefined();
    });

    it.each(cases)('does not query at all for an unassigned account (%s)', async (_label, method) => {
      await (guard as any)[method]('child-1', national);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    /**
     * An import issue can name no assayer — an unmatched source code that never became a person
     * — and `RosterRecordsService.listIssues` deliberately shows those rows to every desk on the
     * grounds that a row nobody can see is a row nobody can fix. The write side has to agree, or
     * a scoped desk would see an entry in its own queue that it could never close. The LEFT JOIN
     * is what produces the null; `assertRegionAllowed` lets a null region through under the rule
     * it already applies to a branch whose region is unknown.
     */
    it('lets an import issue with no assayer through, and reaches it by a LEFT JOIN', async () => {
      dataSource.query.mockResolvedValue([{ region: null }]);
      await expect(guard.assertImportIssueInScope('orphan', west)).resolves.toBeUndefined();
      expect(dataSource.query.mock.calls[0][0]).toContain('LEFT JOIN');
    });

    it('refuses the whole batch of import issues if any one is out of region', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.EAST }, { region: Region.SOUTH }]);
      await expect(guard.assertImportIssuesInScope(['i1', 'i2'], west)).rejects.toThrow(ForbiddenException);
    });

    it('skips an empty import-issue batch without querying', async () => {
      await guard.assertImportIssuesInScope([], west);
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  /**
   * `feedbackVerdict` — whether a socket may join a feedback thread's room. Mirrors the HTTP
   * rule in FeedbackService.findOne: the reporter, or a feedback-team role, may; nobody else.
   * `subscribe:feedback` used to be an unconditional join with no check at all.
   */
  describe('feedbackVerdict', () => {
    const THREAD_ID = '33333333-3333-3333-3333-333333333333';

    let row: any;
    const makeQueryBuilder = () => {
      const qb: any = {};
      for (const method of ['select', 'addSelect', 'where']) qb[method] = jest.fn(() => qb);
      qb.getRawOne = jest.fn(async () => row);
      return qb;
    };

    const guardWithRepo = () => {
      const repo = { createQueryBuilder: jest.fn(() => makeQueryBuilder()) };
      const ds = { getRepository: jest.fn(() => repo) };
      return { guard: new RegionGuardService(ds as any, mockSettings as any), repo };
    };

    it('refuses an unknown thread id', async () => {
      row = undefined;
      const { guard: g } = guardWithRepo();
      const verdict = await g.feedbackVerdict({ id: 'someone' }, THREAD_ID);
      expect(verdict).toEqual({ found: false, allowed: false });
    });

    it('admits the reporter by user id', async () => {
      row = { id: THREAD_ID, reporterUserId: 'reporter-1', reporterAssayerId: null };
      const { guard: g } = guardWithRepo();
      const verdict = await g.feedbackVerdict({ id: 'reporter-1' }, THREAD_ID);
      expect(verdict).toEqual({ found: true, allowed: true });
    });

    it('admits the reporter by assayer id', async () => {
      row = { id: THREAD_ID, reporterUserId: null, reporterAssayerId: 'assayer-1' };
      const { guard: g } = guardWithRepo();
      const verdict = await g.feedbackVerdict({ id: 'assayer-1', roles: [{ name: 'ASSAYER' }] }, THREAD_ID);
      expect(verdict).toEqual({ found: true, allowed: true });
    });

    it('admits a feedback-team member who is not the reporter', async () => {
      row = { id: THREAD_ID, reporterUserId: 'reporter-1', reporterAssayerId: null };
      const { guard: g } = guardWithRepo();
      // DEVELOPER owns the support desk since 2026-09-05 (feedback-roles.ts); ADMIN no longer does.
      const verdict = await g.feedbackVerdict({ id: 'dev-1', roles: [{ name: 'DEVELOPER' }] }, THREAD_ID);
      expect(verdict).toEqual({ found: true, allowed: true });
    });

    it('refuses an administrator — the desk moved to the developer (2026-09-05)', async () => {
      row = { id: THREAD_ID, reporterUserId: 'reporter-1', reporterAssayerId: null };
      const { guard: g } = guardWithRepo();
      const verdict = await g.feedbackVerdict({ id: 'admin-1', roles: [{ name: 'ADMIN' }] }, THREAD_ID);
      expect(verdict).toEqual({ found: true, allowed: false });
    });

    it('refuses a socket that is neither the reporter nor on the feedback team', async () => {
      row = { id: THREAD_ID, reporterUserId: 'reporter-1', reporterAssayerId: null };
      const { guard: g } = guardWithRepo();
      const verdict = await g.feedbackVerdict({ id: 'assayer-2', roles: [{ name: 'ASSAYER' }] }, THREAD_ID);
      expect(verdict).toEqual({ found: true, allowed: false });
    });
  });

  /**
   * `assertProjectInScope` / `assertProjectsInScope` / `assertCoveragePlanInScope` — the
   * planning-controller ceiling. A project has no region of its own (it is a set of branches
   * that can legitimately span several), so unlike the single-record lookups above these refuse
   * the WHOLE request the moment any touched branch falls outside the caller's regions, rather
   * than comparing one region. Added after an adversarial review found `optimize`,
   * `scenarios/simulate`, the four day-plan routes, `coverage-plan` create/transition/execute and
   * `projects/:id/coverage` carried no region check at all.
   */
  describe('project and coverage-plan lookups', () => {
    it('allows a project whose branches are entirely within the held region', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.WEST }, { region: Region.WEST }]);
      await expect(guard.assertProjectInScope('p1', west)).resolves.toBeUndefined();
    });

    it('refuses a project that touches even one branch outside the held region', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.WEST }, { region: Region.SOUTH }]);
      await expect(guard.assertProjectInScope('p1', west)).rejects.toThrow(ForbiddenException);
    });

    // Same reasoning as `assertRegionAllowed`'s null-region case: an unresolved region is a data
    // gap, not a security boundary, and refusing on it would make the branch unfixable.
    it('ignores a branch whose region could not be resolved', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.WEST }, { region: null }]);
      await expect(guard.assertProjectInScope('p1', west)).resolves.toBeUndefined();
    });

    it('does not query at all for an unassigned (national) account', async () => {
      await guard.assertProjectInScope('p1', national);
      await guard.assertProjectsInScope(['p1', 'p2'], national);
      await guard.assertCoveragePlanInScope('plan1', national);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('does not query at all when no project id is given', async () => {
      await guard.assertProjectInScope(undefined, west);
      await guard.assertProjectInScope(null, west);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('skips an empty project list without querying', async () => {
      await expect(guard.assertProjectsInScope([], west)).resolves.toBeUndefined();
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('refuses several projects at once if any of them reaches outside the region', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.WEST }, { region: Region.SOUTH }]);
      await expect(guard.assertProjectsInScope(['p1', 'p2'], west)).rejects.toThrow(ForbiddenException);
      expect(dataSource.query.mock.calls[0][1]).toEqual([['p1', 'p2']]);
    });

    it('walks a coverage plan to its project to that project’s branches', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.SOUTH }]);
      await expect(guard.assertCoveragePlanInScope('plan1', west)).rejects.toThrow(ForbiddenException);
      expect(dataSource.query.mock.calls[0][0]).toContain('coverage_plans');
    });

    it('allows a coverage plan whose project stays inside the held region', async () => {
      dataSource.query.mockResolvedValue([{ region: Region.WEST }]);
      await expect(guard.assertCoveragePlanInScope('plan1', west)).resolves.toBeUndefined();
    });
  });

  /**
   * The staged rollout method for the six boundaries added without a prior region check
   * (document, billing, expense, customer-master, validation-query, client). The one thing
   * every case here must prove: Log and Enforce evaluate the IDENTICAL condition — they may
   * only ever disagree about whether the refusal is real, never about whether one occurred.
   */
  describe('assertRegionAllowedStaged', () => {
    const stagedSettings = { get: jest.fn() };
    const stagedGuard = new RegionGuardService(dataSource as any, stagedSettings as any);

    beforeEach(() => stagedSettings.get.mockReset());

    it('off: skips the check entirely, even for a record that would be refused', async () => {
      stagedSettings.get.mockResolvedValue('off');
      await expect(
        stagedGuard.assertRegionAllowedStaged(Region.SOUTH, west, 'test:off'),
      ).resolves.toBeUndefined();
    });

    it('log: an in-scope record passes silently', async () => {
      stagedSettings.get.mockResolvedValue('log');
      await expect(
        stagedGuard.assertRegionAllowedStaged(Region.WEST, west, 'test:log-allowed'),
      ).resolves.toBeUndefined();
    });

    it('log: an out-of-scope record is let through, not refused', async () => {
      stagedSettings.get.mockResolvedValue('log');
      await expect(
        stagedGuard.assertRegionAllowedStaged(Region.SOUTH, west, 'test:log-refused'),
      ).resolves.toBeUndefined();
    });

    it('enforce: an in-scope record passes', async () => {
      stagedSettings.get.mockResolvedValue('enforce');
      await expect(
        stagedGuard.assertRegionAllowedStaged(Region.WEST, west, 'test:enforce-allowed'),
      ).resolves.toBeUndefined();
    });

    it('enforce: an out-of-scope record is genuinely refused', async () => {
      stagedSettings.get.mockResolvedValue('enforce');
      await expect(
        stagedGuard.assertRegionAllowedStaged(Region.SOUTH, west, 'test:enforce-refused'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('a national (unrestricted) account is never refused in any mode', async () => {
      for (const mode of ['off', 'log', 'enforce']) {
        stagedSettings.get.mockResolvedValue(mode);
        await expect(
          stagedGuard.assertRegionAllowedStaged(Region.SOUTH, national, `test:${mode}-national`),
        ).resolves.toBeUndefined();
      }
    });

    /**
     * REPLACES a test that asserted the opposite, and said so: "a settings-read failure falls
     * back to log behaviour, not enforce … a settings outage must never turn into a new 403 on
     * six screens that had no boundary at all a moment ago."
     *
     * That reasoning was true for about a week, in 2026-09, while `security.regionScope.mode`
     * shipped as `'log'` and the six boundaries were being rolled out. It stopped being true when
     * the observation phase finished and the setting's default became `'enforce'` — recorded in
     * `settings.registry.ts` as "a fail-open access boundary must not be the default a fresh
     * deployment inherits", and pinned by `security-defaults.spec.ts`. The `.catch(() => 'log')`
     * that made it pass was left behind, and it meant a settings read that threw silently demoted
     * every one of those six boundaries from refusing to writing a log line nobody reads.
     *
     * The correct answer to "I cannot find out what the policy is" on a security control is the
     * shipped policy — read from `SETTING_BY_KEY`, so this cannot drift from the registry.
     */
    it('a settings-read failure falls back to the SHIPPED default (enforce), not to log', async () => {
      stagedSettings.get.mockRejectedValue(new Error('cache miss, db down'));
      await expect(
        stagedGuard.assertRegionAllowedStaged(Region.SOUTH, west, 'test:settings-failure'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('a settings-read failure still lets an IN-scope record through', async () => {
      // The fallback tightens the mode, not the predicate: an outage must not start refusing
      // work the caller is plainly entitled to.
      stagedSettings.get.mockRejectedValue(new Error('cache miss, db down'));
      await expect(
        stagedGuard.assertRegionAllowedStaged(Region.WEST, west, 'test:settings-failure-allowed'),
      ).resolves.toBeUndefined();
    });

    it('stagedMode() reports the shipped default when the setting cannot be read', async () => {
      // The list endpoints branch on this rather than calling the assertion, so the same
      // fail-closed answer has to come out of both doors.
      stagedSettings.get.mockRejectedValue(new Error('cache miss, db down'));
      await expect(stagedGuard.stagedMode()).resolves.toBe('enforce');
    });
  });

  /**
   * The invoice ceiling, and the one place in the guard where the CALLER chooses how hard the
   * refusal is.
   *
   * This rule used to exist twice — here, and privately inside `BillingEngineService` as
   * `invoiceRegions` + `assertInvoiceRegionAllowed` — because the writes and the reads were fixed
   * by different workstreams a day apart. Collapsing them left one difference to settle: the
   * private copy went through `assertRegionAllowedStaged` and the shared one enforced outright.
   * Both behaviours survived, selected by `stagedContext`, and these cases pin which caller gets
   * which. The four invoice WRITES pass no context and are refused whatever the setting says; the
   * two READS pass one, so they stay paired with `findInvoicesPage`, which honours the setting
   * too. Delete the `stagedContext` branch and half of this block goes red.
   */
  describe('assertInvoiceInScope', () => {
    /** One row per distinct region the invoice's lines resolve to, as the SQL returns them. */
    const lines = (...regions: Region[]) => regions.map((region) => ({ region }));

    it('never queries at all for an unrestricted account', async () => {
      await expect(guard.assertInvoiceInScope('inv-1', national)).resolves.toBeUndefined();
      await expect(guard.assertInvoiceInScope('inv-1', undefined)).resolves.toBeUndefined();
      await expect(guard.assertInvoiceInScope('inv-1', { regions: [] })).resolves.toBeUndefined();
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('never queries for a missing invoice id', async () => {
      await expect(guard.assertInvoiceInScope(null, west)).resolves.toBeUndefined();
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('allows an invoice whose every line is inside the assignment', async () => {
      dataSource.query.mockResolvedValue(lines(Region.WEST, Region.WEST));
      await expect(guard.assertInvoiceInScope('inv-1', west)).resolves.toBeUndefined();
    });

    it('allows an invoice whose lines resolve to no region at all', async () => {
      // Same data-gap reasoning as `assertRegionAllowed`'s null record region: an invoice nobody
      // can attribute must not become invisible to the only people who could fix it.
      dataSource.query.mockResolvedValue([]);
      await expect(guard.assertInvoiceInScope('inv-1', west)).resolves.toBeUndefined();
    });

    /**
     * The property the whole method exists for, and the one a single-region helper would get
     * wrong: an invoice is a set of assignments and may legitimately straddle regions. Holding
     * ONE of its regions is not enough, because there is no partial view of an invoice — you
     * would be reading, sending or paying money booked in a region you are not assigned to.
     */
    it('refuses a multi-region invoice when ANY line falls outside the assignment', async () => {
      dataSource.query.mockResolvedValue(lines(Region.WEST, Region.SOUTH));
      await expect(guard.assertInvoiceInScope('inv-1', west)).rejects.toThrow(ForbiddenException);
    });

    it('refuses when the out-of-scope line is the first one too — order cannot matter', async () => {
      dataSource.query.mockResolvedValue(lines(Region.SOUTH, Region.WEST));
      await expect(guard.assertInvoiceInScope('inv-1', west)).rejects.toThrow(ForbiddenException);
    });

    /**
     * No context: enforce, whatever the rollout setting says. `mockSettings` here answers 'log'
     * — the mode under which `assertRegionAllowedStaged` deliberately refuses nothing — so this
     * case fails the moment the write path is quietly routed through the staged helper.
     */
    it('with NO context, refuses even while the rollout setting says log — the write contract', async () => {
      dataSource.query.mockResolvedValue(lines(Region.SOUTH));
      await expect(mockSettings.get()).resolves.toBe('log');
      await expect(guard.assertInvoiceInScope('inv-1', west)).rejects.toThrow(ForbiddenException);
    });

    describe('with a context, the staged rollout decides — the read contract', () => {
      const stagedSettings = { get: jest.fn() };
      const stagedGuard = new RegionGuardService(dataSource as any, stagedSettings as any);

      beforeEach(() => stagedSettings.get.mockReset());

      it('off: allows an out-of-scope invoice and does not even resolve the check', async () => {
        stagedSettings.get.mockResolvedValue('off');
        dataSource.query.mockResolvedValue(lines(Region.SOUTH));
        await expect(
          stagedGuard.assertInvoiceInScope('inv-1', west, 'billing-engine:invoice'),
        ).resolves.toBeUndefined();
      });

      /**
       * The reason the reads kept the staged path. `findInvoicesPage` leaves its rows unfiltered
       * in Log mode, and `invoiceInRegion` in `billing-region-scope.ts` states the invariant: an
       * invoice must not be listed or counted and then 403 when the operator opens it. A read
       * that enforced here would break that pairing in the one mode an operator turns to when
       * the boundary is misbehaving.
       */
      it('log: lets an out-of-scope invoice through, so the detail route still agrees with the list', async () => {
        stagedSettings.get.mockResolvedValue('log');
        dataSource.query.mockResolvedValue(lines(Region.SOUTH));
        await expect(
          stagedGuard.assertInvoiceInScope('inv-1', west, 'billing-engine:invoice'),
        ).resolves.toBeUndefined();
      });

      it('enforce: refuses, identically to the no-context path', async () => {
        stagedSettings.get.mockResolvedValue('enforce');
        dataSource.query.mockResolvedValue(lines(Region.SOUTH));
        await expect(
          stagedGuard.assertInvoiceInScope('inv-1', west, 'billing-engine:invoice-document'),
        ).rejects.toThrow(ForbiddenException);
      });

      it('enforce is the shipped default, so a settings outage still refuses', async () => {
        stagedSettings.get.mockRejectedValue(new Error('cache miss, db down'));
        dataSource.query.mockResolvedValue(lines(Region.SOUTH));
        await expect(
          stagedGuard.assertInvoiceInScope('inv-1', west, 'billing-engine:invoice'),
        ).rejects.toThrow(ForbiddenException);
      });

      it('an in-scope invoice passes in every mode', async () => {
        for (const mode of ['off', 'log', 'enforce']) {
          stagedSettings.get.mockResolvedValue(mode);
          dataSource.query.mockResolvedValue(lines(Region.WEST));
          await expect(
            stagedGuard.assertInvoiceInScope('inv-1', west, `test:${mode}`),
          ).resolves.toBeUndefined();
        }
      });
    });
  });

  /**
   * The notification-dispatch ceiling: narrows a candidate id list to the accounts whose region
   * assignment covers one event's region. Same `regionAllowed` predicate as `assertRegionAllowed`
   * above, applied to a list instead of thrown for one record.
   */
  describe('filterUsersByRegion', () => {
    it('passes everyone through, without querying, when the event region could not be resolved', async () => {
      const result = await guard.filterUsersByRegion(['u1', 'u2'], null);
      expect(result).toEqual(['u1', 'u2']);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('passes an empty candidate list through without querying', async () => {
      const result = await guard.filterUsersByRegion([], Region.WEST);
      expect(result).toEqual([]);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('keeps a national account and one assigned to the event region; drops one assigned elsewhere', async () => {
      dataSource.query.mockResolvedValue([
        { id: 'national', regions: null },
        { id: 'same-region', regions: [Region.WEST] },
        { id: 'other-region', regions: [Region.SOUTH] },
      ]);

      const result = await guard.filterUsersByRegion(
        ['national', 'same-region', 'other-region'],
        Region.WEST,
      );

      expect(result).toEqual(['national', 'same-region']);
    });

    it('treats an empty regions array the same as unassigned — national, not scoped to nothing', async () => {
      dataSource.query.mockResolvedValue([{ id: 'u1', regions: [] }]);
      const result = await guard.filterUsersByRegion(['u1'], Region.WEST);
      expect(result).toEqual(['u1']);
    });
  });
});

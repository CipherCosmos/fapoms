import { BranchService } from '../branch/branch.service';
import { ProjectService } from '../project/project.service';
import { NOTIFICATION_CATALOG, renderTemplate } from './notification-catalog';

/**
 * Owner decision 2026-09-24: work cancelled because the office closed a branch or stopped a
 * project used to vanish from the assayer's list with no word. They are now told, in plain words,
 * and their phone refreshes.
 */
describe('a closure cancellation reaches the assayer', () => {
  const rows = [
    { id: 'asn-1', assignment_number: 'ASN-1', status: 'ACCEPTED', project_branch_id: 'pb-1', assayer_id: 'assayer-1', branch_name: 'Thrissur Main' },
    { id: 'asn-2', assignment_number: 'ASN-2', status: 'PENDING', project_branch_id: 'pb-2', assayer_id: null, branch_name: 'Kochi' },
  ];
  const dispatch = { emitSafe: jest.fn() };
  const refresh = { assignmentChanged: jest.fn() };
  const tracking = { disableLiveTrackingWhenWorkEnds: jest.fn(async () => undefined) };
  beforeEach(() => {
    dispatch.emitSafe.mockClear(); refresh.assignmentChanged.mockClear(); tracking.disableLiveTrackingWhenWorkEnds.mockClear();
  });

  /**
   * The transaction's manager. `lockedRows` is what the `FOR UPDATE` read sees; `updatable` is
   * which ids the conditional UPDATE actually changes (all cancellable ones by default).
   */
  const txManager = (lockedRows: any[], updatable?: string[]) => {
    const scheduleUpdate = jest.fn(async () => ({ affected: 1 }));
    const m: any = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        if (sql.includes('SELECT a.id')) return lockedRows;
        if (/UPDATE assignments/.test(sql)) {
          const ids: string[] = params?.[2] ?? [];
          const rowsOut = ids.filter((id) => !updatable || updatable.includes(id)).map((id) => ({ id, entity_version: 7 }));
          return [rowsOut, rowsOut.length];
        }
        return [];
      }),
      getRepository: jest.fn(() => ({ save: jest.fn(async (x: any) => x), update: scheduleUpdate })),
      scheduleUpdate,
    };
    return m;
  };

  const branchService = (m: any) => {
    const svc: any = Object.create(BranchService.prototype);
    svc.loadForWrite = jest.fn(async () => ({ id: 'b-1', name: 'Thrissur Main', isActive: true }));
    svc.dataSource = { query: jest.fn(async () => []), transaction: jest.fn(async (work: any) => work(m)) };
    svc.auditService = { recordEvent: jest.fn() };
    svc.eventPublisher = { publish: jest.fn() };
    svc.branchRepository = { save: jest.fn(async (b: any) => b) };
    svc.notificationDispatch = dispatch;
    svc.refreshPush = refresh;
    svc.assayerService = tracking;
    return svc;
  };

  const projectService = (m: any) => {
    const svc: any = Object.create(ProjectService.prototype);
    svc.findOne = jest.fn(async () => ({ id: 'p-1', name: 'SBI Q3', status: 'EXECUTION', isActive: true }));
    svc.dataSource = { query: jest.fn(async () => []) };
    svc.auditService = { recordEvent: jest.fn() };
    svc.eventPublisher = { publish: jest.fn() };
    svc.projectRepository = { save: jest.fn(async (p: any) => p) };
    // The engine hands the action its transaction's manager — the 9th argument is the action.
    svc.workflowEngine = { executeCommand: jest.fn(async (..._a: any[]) => (_a[8] as (m: any) => Promise<any>)(m)) };
    svc.notificationDispatch = dispatch;
    svc.refreshPush = refresh;
    svc.assayerService = tracking;
    return svc;
  };

  it('branch deactivation', async () => {
    const m = txManager(rows);
    await branchService(m).remove('b-1', 'ops-1');

    const all = dispatch.emitSafe.mock.calls.map((c) => c[0]);
    const emits = all.filter((e) => e.type === 'ASSIGNMENT_CANCELLED_BY_CLOSURE');
    expect(emits).toHaveLength(1); // the unassigned job tells no assayer
    // The desk hears about every cancelled job (B1, 2026-09-24), assigned or not.
    expect(all.filter((e) => e.type === 'ASSIGNMENT_CANCELLED_DESK').map((e) => e.entityId)).toEqual(['asn-1', 'asn-2']);
    expect(emits[0]).toMatchObject({
      type: 'ASSIGNMENT_CANCELLED_BY_CLOSURE', assayerId: 'assayer-1',
      // The committed version is the occurrence (assignment-notification-keys.ts).
      dedupeKey: 'ASSIGNMENT_CANCELLED_BY_CLOSURE:asn-1:7',
      payload: { branchName: 'Thrissur Main', because: 'the office has closed this branch' },
    });
    expect(refresh.assignmentChanged).toHaveBeenCalledWith('assayer-1', 'asn-1');
  });

  it('project cancellation', async () => {
    const m = txManager(rows);
    await projectService(m).cancelProject('p-1', 'ops-1');

    const [e] = dispatch.emitSafe.mock.calls.map((c) => c[0]);
    expect(e).toMatchObject({
      type: 'ASSIGNMENT_CANCELLED_BY_CLOSURE', assayerId: 'assayer-1',
      payload: { branchName: 'Thrissur Main', because: 'the office has stopped this audit project' },
    });
    expect(refresh.assignmentChanged).toHaveBeenCalledWith('assayer-1', 'asn-1');
  });

  /**
   * E7: the cancel is decided on locked rows and only lands on rows still PENDING/ACCEPTED, on the
   * closure's own transaction; the calendar and location sharing are cleared like a single cancel.
   */
  describe.each([
    ['branch deactivation', (m: any) => branchService(m).remove('b-1', 'ops-1')],
    ['project cancellation', (m: any) => projectService(m).cancelProject('p-1', 'ops-1')],
  ] as Array<[string, (m: any) => Promise<unknown>]>)('%s — closure integrity', (_name, close) => {
    it('reads the work FOR UPDATE and cancels only rows still PENDING/ACCEPTED, on the transaction', async () => {
      const m = txManager(rows);
      await close(m);
      const sqls: string[] = m.query.mock.calls.map((c: any[]) => c[0]);
      expect(sqls.find((q) => q.includes('SELECT a.id'))).toMatch(/FOR UPDATE/);
      expect(sqls.find((q) => /UPDATE assignments/.test(q))).toMatch(/status IN \('PENDING', 'ACCEPTED'\)/);
    });

    it('refuses — and cancels and tells nobody — when a row moved on site before the lock', async () => {
      // The unlocked pre-read used to see ACCEPTED here; the locked read sees the check-in.
      const m = txManager([{ ...rows[0], status: 'CHECKED_IN' }, rows[1]]);
      await expect(close(m)).rejects.toThrow(/currently CHECKED_IN/);
      expect(m.query.mock.calls.some((c: any[]) => /UPDATE assignments/.test(c[0]))).toBe(false);
      expect(dispatch.emitSafe).not.toHaveBeenCalled();
      expect(tracking.disableLiveTrackingWhenWorkEnds).not.toHaveBeenCalled();
    });

    it('refuses the closure when the conditional cancel did not take a row, and tells nobody', async () => {
      const m = txManager(rows, ['asn-2']); // asn-1 no longer PENDING/ACCEPTED at UPDATE time
      await expect(close(m)).rejects.toThrow(/changed while the closure was running/);
      expect(dispatch.emitSafe).not.toHaveBeenCalled();
    });

    it("retires the cancelled jobs' calendar entries and switches the assayer's sharing off", async () => {
      const m = txManager(rows);
      await close(m);
      expect(m.scheduleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true }),
        expect.objectContaining({ isActive: false, updatedBy: 'ops-1' }),
      );
      const where = (m.scheduleUpdate.mock.calls[0] as any[])[0];
      expect(where.assignmentId.value).toEqual(['asn-1', 'asn-2']);
      expect(tracking.disableLiveTrackingWhenWorkEnds).toHaveBeenCalledWith('assayer-1', 'ops-1');
    });
  });

  /**
   * Travel once per assayer per day (E2): a closure may cancel the job that carried the assayer's
   * journey for its day. After the closure commits, each (assayer, day) it touched is re-decided —
   * never before (a refused closure re-decides nothing).
   */
  describe.each([
    ['branch deactivation', (m: any, dt: any) => { const s = branchService(m); s.dayTravel = dt; return s.remove('b-1', 'ops-1'); }],
    ['project cancellation', (m: any, dt: any) => { const s = projectService(m); s.dayTravel = dt; return s.cancelProject('p-1', 'ops-1'); }],
  ] as Array<[string, (m: any, dt: any) => Promise<unknown>]>)('%s — the day\'s travel is re-decided', (_name, close) => {
    const dated = rows.map((r) => ({ ...r, scheduled_date: '2026-10-05' }));

    it('for every cancelled job, with its assayer and day, after commit', async () => {
      const dayTravel = { rebalanceMany: jest.fn(async () => undefined) };
      const m = txManager(dated);
      await close(m, dayTravel);
      expect(dayTravel.rebalanceMany).toHaveBeenCalledTimes(1);
      const [pairs, userId] = (dayTravel.rebalanceMany.mock.calls as any[])[0];
      expect(pairs).toEqual([{ assayerId: 'assayer-1', day: '2026-10-05' }, { assayerId: null, day: '2026-10-05' }]);
      expect(userId).toBe('ops-1');
      // The locked read carries the day for it.
      expect(m.query.mock.calls.find((c: any[]) => c[0].includes('SELECT a.id'))[0]).toMatch(/a\.scheduled_date/);
    });

    it('not at all when the closure is refused', async () => {
      const dayTravel = { rebalanceMany: jest.fn(async () => undefined) };
      const m = txManager([{ ...dated[0], status: 'CHECKED_IN' }, dated[1]]);
      await expect(close(m, dayTravel)).rejects.toThrow(/currently CHECKED_IN/);
      expect(dayTravel.rebalanceMany).not.toHaveBeenCalled();
    });
  });

  it('project removal re-decides the days of the live work it deactivates', async () => {
    const svc: any = Object.create(ProjectService.prototype);
    svc.findOne = jest.fn(async () => ({ id: 'p-1', name: 'SBI Q3', isActive: true }));
    svc.projectRepository = { save: jest.fn(async (p: any) => p) };
    svc.auditService = { recordEvent: jest.fn() };
    svc.eventPublisher = { publish: jest.fn() };
    const order: string[] = [];
    svc.dataSource = {
      query: jest.fn(async (sql: string) => {
        if (/SELECT DISTINCT assayer_id, scheduled_date FROM assignments/.test(sql)) { order.push('read'); return [{ assayer_id: 'assayer-1', scheduled_date: '2026-10-05' }]; }
        if (/UPDATE assignments/.test(sql)) order.push('deactivate');
        return [];
      }),
    };
    svc.dayTravel = { rebalanceMany: jest.fn(async () => { order.push('rebalance'); }) };
    await svc.remove('p-1', 'ops-1');
    expect(order).toEqual(['read', 'deactivate', 'rebalance']);
    expect(svc.dayTravel.rebalanceMany).toHaveBeenCalledWith([{ assayerId: 'assayer-1', day: '2026-10-05' }], 'ops-1', expect.stringContaining('SBI Q3'));
  });

  it('project cancellation writes nothing outside the command transaction', async () => {
    const m = txManager(rows);
    const svc = projectService(m);
    await svc.cancelProject('p-1', 'ops-1');
    expect(svc.dataSource.query).not.toHaveBeenCalled();
    expect(svc.projectRepository.save).not.toHaveBeenCalled();
  });

  it('reads plainly on a lock screen', () => {
    const def = NOTIFICATION_CATALOG.ASSIGNMENT_CANCELLED_BY_CLOSURE;
    expect(renderTemplate(def.body, { branchName: 'Thrissur Main', because: 'the office has closed this branch' }))
      .toBe('Your job at Thrissur Main is cancelled because the office has closed this branch. Do not go to the branch for it.');
    expect(renderTemplate(NOTIFICATION_CATALOG.ASSIGNMENT_DATE_CHANGED.body, { branchName: 'Kochi', newDate: 'Monday, 28 September', alsoNote: '' }))
      .toBe('Your job at Kochi is now on Monday, 28 September.');
  });

  it('the dead types are gone from the catalog', () => {
    expect(NOTIFICATION_CATALOG.SCHEDULE_CANCELLED).toBeUndefined();
    expect(NOTIFICATION_CATALOG.DOCUMENT_REJECTED).toBeUndefined();
    for (const t of ['ASSIGNMENT_REOPENED', 'ASSIGNMENT_DATE_CHANGED', 'ASSIGNMENT_NOTE_CHANGED', 'ASSIGNMENT_MARKED_URGENT', 'ASSIGNMENT_CANCELLED_BY_CLOSURE']) {
      expect(NOTIFICATION_CATALOG[t]).toMatchObject({ special: ['ASSIGNED_ASSAYER'], skipActor: true });
    }
  });
});

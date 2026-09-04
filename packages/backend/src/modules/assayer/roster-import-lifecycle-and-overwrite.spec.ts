import * as xlsx from 'xlsx';
import { AssayerLifecycleStatus } from '@fapoms/shared';
import { RosterImportService } from './roster-import.service';

/**
 * Two of the importer fixes, proved directly against the private row-writing logic:
 *
 *  - The importer used to write `lifecycleStatus` straight onto the entity, bypassing the same
 *    transition table `AssayerStateMachine` enforces everywhere else. An existing record whose
 *    sheet implies a move the state machine would refuse must be left alone and reviewed, not
 *    forced. A brand new row has no prior state to validate a move *from*, so it is created at
 *    whatever status the sheet says — except when the availability/status columns exist and
 *    this row's cell in them is blank or unreadable, which must be a review issue rather than a
 *    silent INVITED.
 *  - "Sheet wins" is opt-in per field for PAN/phone/address/bank/IFSC/dates/notes: filling a
 *    blank always happens, but a sheet value that DISAGREES with what is already on file is
 *    filed as a review issue unless the caller passed `overwrite: true`.
 */
describe('roster import — lifecycle transitions go through the state machine', () => {
  const HEADERS = [
    'Appraiser Name', 'Appraiser code', 'Residence Address', 'Location', 'District', 'State',
    'Active / Inactive', 'Status',
  ];

  const row = (code: string, availability: string, status = '') =>
    [`Person ${code}`, code, 'Main Road', 'Town', 'District', 'Kerala', availability, status];

  const book = (rows: any[][]): Buffer => {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([HEADERS, ...rows]), 'Assayer');
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };

  /**
   * A legal transition on an existing row is no longer written straight onto `a.lifecycleStatus`
   * during the row's own save — it is queued and run through `bulkTransitionLifecycle` (the same
   * helper HR's own transition endpoint uses) once the row's transaction commits, so it gets the
   * same departure-date reconciliation and audit trail a manual transition gets. That call only
   * fires on a real run (`dryRun: false`), which is why the harness takes a mock for it and the
   * legal-transition test below drives a real run and asserts on the call rather than on
   * `savedAssayers[0].lifecycleStatus`, which no longer reflects a queued move.
   */
  const harness = (existing: Array<Record<string, any>> = [], bulkTransitionLifecycle = jest.fn().mockResolvedValue({ succeeded: [], skipped: [], failed: [] })) => {
    const savedAssayers: any[] = [];
    const savedIssues: any[] = [];
    let n = 1;
    const manager: any = {
      find: async () => [],
      createQueryBuilder: (entity: any) => {
        let codes: string[] = [];
        const qb: any = {
          where: (_sql: string, params?: any) => { codes = params?.codes ?? codes; return qb; },
          getMany: async () => (entity?.name === 'AssayerEntity' ? existing.filter((a) => codes.includes(a.assayerCode)) : []),
        };
        qb.andWhere = qb.where;
        return qb;
      },
      findOne: async () => undefined,
      query: async () => undefined,
      create: (_entity: any, obj: any) => (_entity?.name === 'AssayerEntity' ? { lifecycleStatus: 'INVITED', ...obj } : { ...obj }),
      save: async (entity: any, obj: any) => {
        if (obj && obj.id == null) obj.id = `id-${n++}`;
        if (entity?.name === 'AssayerEntity') savedAssayers.push(obj);
        if (entity?.name === 'AssayerImportIssueEntity') savedIssues.push(obj);
        return obj;
      },
    };

    const service = new RosterImportService(
      { run: (work: any) => work(manager, () => {}) } as any,
      { enqueueBackfill: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn().mockResolvedValue(false) } as any,
      undefined,
      { bulkTransitionLifecycle } as any,
    );

    return { service, savedAssayers, savedIssues, bulkTransitionLifecycle };
  };

  /**
   * ACTIVE -> TERMINATED is not a legal edge (`ASSAYER_LIFECYCLE_TRANSITIONS[ACTIVE]` is
   * ON_LEAVE/SUSPENDED/INACTIVE/RESIGNED only). Before this fix the importer wrote
   * `a.lifecycleStatus = 'TERMINATED'` unconditionally and this test would find the saved row
   * at TERMINATED with no issue at all — proving the state-machine gate is what changed.
   */
  it('refuses to force an existing record through a transition the state machine does not allow', async () => {
    const h = harness([{ id: 'a-1', assayerCode: 'AS001', lifecycleStatus: AssayerLifecycleStatus.ACTIVE }]);
    await h.service.importAssayerSheet(book([row('AS001', '', 'Terminated')]), 'user-1', { dryRun: true });

    expect(h.savedAssayers[0].lifecycleStatus).toBe(AssayerLifecycleStatus.ACTIVE);
    const issue = h.savedIssues.find((i) => i.sourceAssayerCode === 'AS001');
    expect(issue).toBeDefined();
    expect(issue.reason).toMatch(/cannot move there directly/);
  });

  /**
   * The same move IS legal starting from SUSPENDED, and must be queued for `bulkTransitionLifecycle`
   * with no issue filed. A real run, not a rehearsal: the queued call only fires once the row's
   * own transaction has committed, which a rehearsal's rollback never reaches.
   */
  it('applies the same move when the current status makes it legal', async () => {
    const h = harness([{ id: 'a-1', assayerCode: 'AS002', lifecycleStatus: AssayerLifecycleStatus.SUSPENDED }]);
    await h.service.importAssayerSheet(book([row('AS002', '', 'Terminated')]), 'user-1', { dryRun: false });

    expect(h.bulkTransitionLifecycle).toHaveBeenCalledWith(
      ['a-1'], AssayerLifecycleStatus.TERMINATED, 'user-1', expect.any(String),
    );
    expect(h.savedIssues.find((i) => i.sourceAssayerCode === 'AS002')).toBeUndefined();
  });

  /**
   * A rehearsal rolls its own row-level writes back, so it must not also run a real lifecycle
   * transition on someone else's behalf — that would be the one write a `dryRun: true` import
   * actually keeps. `dryRun` throws before the queued-transition block is ever reached; this
   * proves it, rather than trusting the control flow by reading it.
   */
  it('does not run the queued transition during a rehearsal', async () => {
    const h = harness([{ id: 'a-1', assayerCode: 'AS002', lifecycleStatus: AssayerLifecycleStatus.SUSPENDED }]);
    await h.service.importAssayerSheet(book([row('AS002', '', 'Terminated')]), 'user-1', { dryRun: true });

    expect(h.bulkTransitionLifecycle).not.toHaveBeenCalled();
  });

  /**
   * A brand new person has no prior status to transition FROM — this is a creation, not a
   * transition — so the sheet's status is simply the status they are created at.
   */
  it('creates a brand new row at whatever status the sheet reports, without a transition check', async () => {
    const h = harness([]);
    await h.service.importAssayerSheet(book([row('AS003', 'Active / Regular')]), 'user-1', { dryRun: true });

    expect(h.savedAssayers[0].lifecycleStatus).toBe(AssayerLifecycleStatus.ACTIVE);
    expect(h.savedIssues.find((i) => i.sourceAssayerCode === 'AS003')).toBeUndefined();
  });

  /**
   * A new row with the availability/status columns present but this row's cells blank used to
   * be silently left at INVITED, indistinguishable from a person genuinely just invited. It must
   * now be flagged for review instead.
   */
  it('files a review issue for a new row with a blank availability cell, rather than a silent INVITED', async () => {
    const h = harness([]);
    await h.service.importAssayerSheet(book([row('AS004', '', '')]), 'user-1', { dryRun: true });

    expect(h.savedAssayers[0].lifecycleStatus).toBe(AssayerLifecycleStatus.INVITED);
    const issue = h.savedIssues.find((i) => i.sourceAssayerCode === 'AS004');
    expect(issue).toBeDefined();
    expect(issue.reason).toMatch(/left at INVITED for manual review/);
  });

  /**
   * A file that never carried an availability/status column at all (a partial correction sheet)
   * is a different case from a roster that has the column and left one row's cell empty — `read`
   * cannot tell the two apart on its own, which is why this is checked against the header list.
   */
  it('does not flag a new row when the file has no availability/status column at all', async () => {
    const wb = xlsx.utils.book_new();
    const noAvailabilityHeaders = ['Appraiser Name', 'Appraiser code', 'Residence Address', 'Location', 'District', 'State'];
    xlsx.utils.book_append_sheet(
      wb, xlsx.utils.aoa_to_sheet([noAvailabilityHeaders, ['Person AS005', 'AS005', 'Main Road', 'Town', 'District', 'Kerala']]), 'Assayer',
    );
    const buffer = Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));

    const h = harness([]);
    await h.service.importAssayerSheet(buffer, 'user-1', { dryRun: true });

    expect(h.savedAssayers[0].lifecycleStatus).toBe(AssayerLifecycleStatus.INVITED);
    expect(h.savedIssues.find((i) => i.sourceAssayerCode === 'AS005')).toBeUndefined();
  });
});

describe('roster import — "sheet wins" is opt-in per field', () => {
  const HEADERS = ['Appraiser Name', 'Appraiser code', 'PAN Number', 'Residence Address', 'Location', 'District', 'State'];

  const row = (code: string, pan: string) =>
    [`Person ${code}`, code, pan, 'Main Road', 'Town', 'District', 'Kerala'];

  const book = (rows: any[][]): Buffer => {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([HEADERS, ...rows]), 'Assayer');
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };

  const harness = (existing: Array<Record<string, any>>) => {
    const savedAssayers: any[] = [];
    const savedIssues: any[] = [];
    let n = 1;
    const manager: any = {
      find: async () => [],
      createQueryBuilder: (entity: any) => {
        let codes: string[] = [];
        const qb: any = {
          where: (_sql: string, params?: any) => { codes = params?.codes ?? codes; return qb; },
          getMany: async () => (entity?.name === 'AssayerEntity' ? existing.filter((a) => codes.includes(a.assayerCode)) : []),
        };
        qb.andWhere = qb.where;
        return qb;
      },
      findOne: async () => undefined,
      query: async () => undefined,
      create: (_entity: any, obj: any) => ({ ...obj }),
      save: async (entity: any, obj: any) => {
        if (obj && obj.id == null) obj.id = `id-${n++}`;
        if (entity?.name === 'AssayerEntity') savedAssayers.push(obj);
        if (entity?.name === 'AssayerImportIssueEntity') savedIssues.push(obj);
        return obj;
      },
    };

    const service = new RosterImportService(
      { run: (work: any) => work(manager, () => {}) } as any,
      { enqueueBackfill: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn().mockResolvedValue(false) } as any,
    );

    return { service, savedAssayers, savedIssues };
  };

  /**
   * Before this fix, every readable non-blank PAN cell overwrote the stored value unconditionally
   * — this test's assertion on the ORIGINAL PAN would fail against that code, which would have
   * silently replaced it with the sheet's differing value.
   */
  it('leaves a stored PAN alone when the sheet disagrees, and files a review issue, with overwrite off (the default)', async () => {
    const h = harness([{ id: 'a-1', assayerCode: 'AS101', panNumber: 'AAAAA1111A' }]);
    await h.service.importAssayerSheet(book([row('AS101', 'BBBBB2222B')]), 'user-1', { dryRun: true });

    expect(h.savedAssayers[0].panNumber).toBe('AAAAA1111A');
    const issue = h.savedIssues.find((i) => i.sourceAssayerCode === 'AS101');
    expect(issue).toBeDefined();
    expect(issue.reason).toMatch(/Sheet differs from record/);
  });

  it('overwrites the stored PAN when the caller opts in', async () => {
    const h = harness([{ id: 'a-1', assayerCode: 'AS102', panNumber: 'AAAAA1111A' }]);
    await h.service.importAssayerSheet(book([row('AS102', 'BBBBB2222B')]), 'user-1', { dryRun: true, overwrite: true });

    expect(h.savedAssayers[0].panNumber).toBe('BBBBB2222B');
    expect(h.savedIssues.find((i) => i.sourceAssayerCode === 'AS102')).toBeUndefined();
  });

  /** Filling a blank is always safe and always happens, overwrite setting notwithstanding. */
  it('fills a blank PAN from the sheet even with overwrite off', async () => {
    const h = harness([{ id: 'a-1', assayerCode: 'AS103', panNumber: null }]);
    await h.service.importAssayerSheet(book([row('AS103', 'CCCCC3333C')]), 'user-1', { dryRun: true });

    expect(h.savedAssayers[0].panNumber).toBe('CCCCC3333C');
    expect(h.savedIssues.find((i) => i.sourceAssayerCode === 'AS103')).toBeUndefined();
  });
});

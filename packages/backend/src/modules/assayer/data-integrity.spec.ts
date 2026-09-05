import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';
import { businessTodayDateKey } from '@fapoms/shared';
import {
  DataIntegrityService, CHECK_TITLES, DATA_INTEGRITY_SHEET, AUTO_CLOSE_RESOLUTION,
} from './data-integrity.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';

/**
 * The data-integrity scan, pinned on its promises rather than its queries.
 *
 * The properties that matter are the ones a clerk depends on without knowing it: the same
 * defect is the same row forever (two runs write nothing new), a decision a person made is
 * never overwritten, a defect that changes after a decision gets a fresh look, a defect that
 * disappears closes its own report, and no identity number ever lands in a queue that is
 * rendered on screen. Each is asserted against an in-memory issue store that enforces the
 * same (sheet, row, column) uniqueness the real table gets from migration
 * 1792400000000-OneIssuePerCell — because the entity itself carries no @Unique, a collision
 * here would otherwise pass silently and fail only in production.
 */

/** In-memory stand-in for the issues repository, understanding the operators the service uses. */
class FakeIssueRepo {
  rows: any[] = [];
  private seq = 0;

  /** null = `_fix_backup_corrupt_dates` does not exist (the guard's negative branch). */
  backupRows: Array<{ assayer_code: string; old_date_of_birth: string | null; old_exit_date: string | null }> | null = null;
  docHolders = 0;
  queryLog: string[] = [];

  /** Counts every `manager.query` call whose SQL is the bulk latest-generation read — the
   * assertion that query count stays flat regardless of finding count reads this, not
   * `queryLog.length`, so it is not thrown off by the unrelated backup/doc-count queries. */
  bulkReadCalls = 0;
  bulkUpdateCalls = 0;

  manager = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      this.queryLog.push(sql);
      if (sql.includes('to_regclass')) {
        return [{ t: this.backupRows === null ? null : '_fix_backup_corrupt_dates' }];
      }
      if (sql.includes('FROM _fix_backup_corrupt_dates')) {
        const rows = this.backupRows ?? [];
        return sql.includes('WHERE assayer_code = $1') ? rows.filter((r) => r.assayer_code === params[0]) : rows;
      }
      if (sql.includes('COUNT(DISTINCT assayer_id)')) return [{ people: this.docHolders }];
      if (sql.includes('DISTINCT ON (source_column)')) {
        this.bulkReadCalls += 1;
        const [sourceSheet, columns] = params as [string, string[]];
        const byColumn = new Map<string, any>();
        for (const row of this.rows) {
          if (row.sourceSheet !== sourceSheet || !columns.includes(row.sourceColumn)) continue;
          const current = byColumn.get(row.sourceColumn);
          if (!current || row.sourceRow > current.sourceRow) byColumn.set(row.sourceColumn, row);
        }
        return [...byColumn.values()].map((r) => ({
          id: r.id, source_column: r.sourceColumn, source_row: r.sourceRow,
          raw_value: r.rawValue, reason: r.reason, assayer_id: r.assayerId,
          source_assayer_code: r.sourceAssayerCode, resolved_at: r.resolvedAt,
          resolved_by: r.resolvedBy, resolution: r.resolution,
        }));
      }
      if (sql.startsWith('UPDATE assayer_import_issues AS t')) {
        this.bulkUpdateCalls += 1;
        // Five params per row: id, rawValue, reason, assayerId, sourceAssayerCode.
        for (let i = 0; i < params.length; i += 5) {
          const row = this.rows.find((r) => r.id === params[i]);
          if (!row) continue;
          row.rawValue = params[i + 1];
          row.reason = params[i + 2];
          row.assayerId = params[i + 3];
          row.sourceAssayerCode = params[i + 4];
          row.updatedBy = 'SYSTEM';
        }
        return [];
      }
      throw new Error(`FakeIssueRepo: unexpected SQL ${sql}`);
    }),
  };

  create = jest.fn((x: any) => ({ ...x }));

  findOne = jest.fn(async (opts: any) => {
    const matched = this.matching(opts.where);
    if (opts.order?.sourceRow === 'DESC') matched.sort((a, b) => b.sourceRow - a.sourceRow);
    return matched[0] ?? null;
  });

  find = jest.fn(async (opts: any) => this.matching(opts.where));

  save = jest.fn(async (row: any) => {
    if (!row.id) {
      const clash = this.rows.find((r) =>
        r.sourceSheet === row.sourceSheet && r.sourceRow === row.sourceRow && r.sourceColumn === row.sourceColumn);
      if (clash) throw new Error(`unique (sheet,row,column) violated: ${row.sourceColumn} @ ${row.sourceRow}`);
      row.id = `issue-${++this.seq}`;
      // Mirror the column defaults a real insert-then-read would show.
      row.resolvedAt ??= null;
      row.resolvedBy ??= null;
      row.resolution ??= null;
      this.rows.push(row);
    } else if (!this.rows.includes(row)) {
      const i = this.rows.findIndex((r) => r.id === row.id);
      if (i >= 0) this.rows[i] = row; else this.rows.push(row);
    }
    return row;
  });

  /** `repository.insert(rows[])` — one call for the whole batch, exactly like the real bulk INSERT. */
  insert = jest.fn(async (rows: any[]) => {
    for (const values of rows) {
      const row = { ...values };
      const clash = this.rows.find((r) =>
        r.sourceSheet === row.sourceSheet && r.sourceRow === row.sourceRow && r.sourceColumn === row.sourceColumn);
      if (clash) throw new Error(`unique (sheet,row,column) violated: ${row.sourceColumn} @ ${row.sourceRow}`);
      row.id = `issue-${++this.seq}`;
      row.resolvedAt ??= null;
      row.resolvedBy ??= null;
      row.resolution ??= null;
      this.rows.push(row);
    }
    return { identifiers: rows.map(() => ({})) };
  });

  /** Stands in for `repository.createQueryBuilder().update(...).set(...).whereInIds(...).execute()` —
   * the bulk auto-close write. Only the `.update().set().whereInIds().execute()` chain the service
   * actually calls is implemented. */
  createQueryBuilder = jest.fn(() => {
    let pendingSet: any = null;
    const builder: any = {
      update: () => builder,
      set: (values: any) => { pendingSet = values; return builder; },
      whereInIds: (ids: string[]) => {
        builder.__ids = ids;
        return builder;
      },
      execute: async () => {
        for (const id of builder.__ids ?? []) {
          const row = this.rows.find((r) => r.id === id);
          if (!row) continue;
          row.resolvedAt = typeof pendingSet.resolvedAt === 'function' ? new Date() : pendingSet.resolvedAt;
          row.resolvedBy = pendingSet.resolvedBy;
          row.resolution = pendingSet.resolution;
          row.updatedBy = pendingSet.updatedBy;
        }
        return {};
      },
    };
    return builder;
  });

  seed(row: any) {
    this.rows.push({ id: `seed-${++this.seq}`, sourceRow: 0, resolvedAt: null, ...row });
  }

  scanner(filter?: (r: any) => boolean) {
    const mine = this.rows.filter((r) => r.sourceSheet === DATA_INTEGRITY_SHEET);
    return filter ? mine.filter(filter) : mine;
  }

  private matching(where: any): any[] {
    return this.rows.filter((row) => Object.entries(where ?? {}).every(([key, cond]) => {
      if (cond instanceof FindOperator) {
        if (cond.type === 'in') return (cond.value as any[]).includes(row[key]);
        if (cond.type === 'isNull') return row[key] == null;
        throw new Error(`FakeIssueRepo: unhandled operator ${cond.type}`);
      }
      return row[key] === cond;
    }));
  }
}

const today = businessTodayDateKey();          // 'YYYY-MM-DD' in business time
const thisYear = Number(today.slice(0, 4));

/** A person with nothing wrong — the base every test perturbs one field on. */
const person = (over: Partial<Record<keyof AssayerEntity, any>> & { assayerCode: string }): AssayerEntity => ({
  id: `id-${over.assayerCode}`,
  displayName: `Person ${over.assayerCode}`,
  lifecycleStatus: 'ACTIVE',
  // The default person has a photograph, so the aggregate check for missing ones fires only in the
  // tests that are about it rather than adding a finding to every other test's count.
  photograph: 'scans/photo.jpg',
  dateOfBirth: '1980-06-15',
  joiningDate: '2020-01-01',
  exitDate: null,
  terminationDate: null,
  region: 'West',
  latitude: 19.1, longitude: 72.8,
  // A complete, unremarkable person: every default is deliberately VALID so a test that sets one
  // bad field isolates exactly the check it is about. `address` and `phone` carry values because
  // blank ones are themselves findings ("No home address on the record", "No phone number on the
  // record") — leaving them null made every unrelated test raise three findings instead of one.
  address: '12 Mahatma Gandhi Road, Andheri',
  panNumber: null, aadhaarNumber: null, bankAccountNumber: null, phone: '9876543210', email: null,
  isActive: true,
  ...over,
} as any);

describe('DataIntegrityService', () => {
  let service: DataIntegrityService;
  let issues: FakeIssueRepo;
  let people: AssayerEntity[];
  let receivedDocs: number;
  let verifiedDocs: number;
  let rejectedDocs: any[];
  let empanelmentRows: any[];

  const scan = () => service.scan();

  beforeEach(async () => {
    issues = new FakeIssueRepo();
    people = [];
    receivedDocs = 0;
    verifiedDocs = 0;
    rejectedDocs = [];
    empanelmentRows = [];

    const mod = await Test.createTestingModule({
      providers: [
        DataIntegrityService,
        {
          provide: getRepositoryToken(AssayerEntity),
          useValue: {
            find: jest.fn(async () => people),
            findOne: jest.fn(async (opts: any) => people.find((p) => p.id === opts.where.id) ?? null),
          },
        },
        {
          provide: getRepositoryToken(AssayerDocumentEntity),
          useValue: {
            // First shape (array where = OR) is the received count; the object shape is verified.
            count: jest.fn(async (opts: any) => (Array.isArray(opts?.where) ? receivedDocs : verifiedDocs)),
            // The rejected-document check reads rows rather than counting them.
            find: jest.fn(async () => rejectedDocs),
          },
        },
        {
          provide: getRepositoryToken(AssayerClientEmpanelmentEntity),
          useValue: { find: jest.fn(async () => empanelmentRows) },
        },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: issues },
      ],
    }).compile();
    service = mod.get(DataIntegrityService);
  });

  // ── The key: stable across runs ─────────────────────────────────────────

  it('writes each defect once, keyed by check title and code, on its own sheet', async () => {
    people = [person({ assayerCode: 'AS0001', region: null })];

    await scan();

    const rows = issues.scanner();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceSheet: DATA_INTEGRITY_SHEET,
      sourceColumn: `${CHECK_TITLES.noRegion} · AS0001`,
      sourceRow: 0,
      assayerId: 'id-AS0001',
      sourceAssayerCode: 'AS0001',
      createdBy: 'SYSTEM',
    });
    expect(rows[0].reason).toContain('AS0001');
    expect(rows[0].reason).toContain('region');
  });

  /**
   * A queue that cannot be emptied stops being read.
   *
   * 34 of the 101 live "No date of birth" findings named TERMINATED or RESIGNED people, each
   * telling a clerk to "enter it from their PAN copy" for somebody who left the company. Those
   * rows can be neither actioned nor dismissed, so they accumulate and bury the 51 that are real.
   * The "go and fill this in" checks are therefore scoped to people still on the roster — while
   * the checks that are ABOUT departure are deliberately not.
   */
  describe('findings a clerk can actually act on', () => {
    it.each([
      ['TERMINATED'], ['RESIGNED'], ['ARCHIVED'],
    ])('does not ask anyone to complete the record of a %s person', async (lifecycle) => {
      people = [person({ assayerCode: 'AS0200', lifecycleStatus: lifecycle,
        dateOfBirth: null, address: '', phone: '' })];

      await scan();

      const nags = issues.scanner().filter((r: any) =>
        r.sourceColumn.startsWith('No date of birth')
        || r.sourceColumn.startsWith('No home address')
        || r.sourceColumn.startsWith('No phone number'));
      expect(nags).toHaveLength(0);
    });

    it('still asks for an active person with the same gaps', async () => {
      people = [person({ assayerCode: 'AS0201', lifecycleStatus: 'ACTIVE',
        dateOfBirth: null, address: '', phone: '' })];

      await scan();

      const nags = issues.scanner().filter((r: any) =>
        r.sourceColumn.startsWith('No date of birth')
        || r.sourceColumn.startsWith('No home address')
        || r.sourceColumn.startsWith('No phone number'));
      expect(nags).toHaveLength(3);
    });

    /**
     * The other direction: a departed person is exactly who the lifecycle checks are for, so
     * scoping must not silence those.
     */
    it('still reports a departed person with no leaving date', async () => {
      people = [person({ assayerCode: 'AS0202', lifecycleStatus: 'RESIGNED',
        exitDate: null, terminationDate: null })];

      await scan();

      expect(issues.scanner().some((r: any) => r.sourceColumn.startsWith('Left with no leaving date'))).toBe(true);
    });

    /**
     * The importer files a death as INACTIVE + unavailableReason, not as a lifecycle value — so
     * `hasLeft` has to know about it, or AS0055 (real, no leaving date of any kind) stays
     * invisible to a check whose title says it finds exactly that.
     */
    it('treats a deceased person as departed, in both directions', async () => {
      people = [person({ assayerCode: 'AS0055', lifecycleStatus: 'INACTIVE',
        unavailableReason: 'DECEASED', exitDate: null, terminationDate: null,
        dateOfBirth: null })];

      await scan();

      const rows = issues.scanner();
      expect(rows.some((r: any) => r.sourceColumn.startsWith('Left with no leaving date'))).toBe(true);
      expect(rows.some((r: any) => r.sourceColumn.startsWith('No date of birth'))).toBe(false);
    });

    /**
     * `hasLeft` admits four kinds of departure but the sentence describing one was a two-way
     * TERMINATED/else split, so archived and deceased people both came out as "is marked
     * resigned" — and were then sent to a resignation letter that does not exist. Telling a
     * clerk that a dead colleague resigned is worse than telling them nothing.
     */
    it('does not tell a clerk that a deceased or archived person resigned', async () => {
      people = [
        person({ assayerCode: 'AS0055', lifecycleStatus: 'INACTIVE',
          unavailableReason: 'DECEASED', exitDate: null, terminationDate: null }),
        person({ assayerCode: 'AS0056', lifecycleStatus: 'ARCHIVED',
          exitDate: null, terminationDate: null }),
      ];

      await scan();

      const reasonFor = (code: string) => issues.scanner()
        .find((r: any) => r.sourceColumn === `Left with no leaving date · ${code}`)?.reason as string;

      expect(reasonFor('AS0055')).not.toMatch(/resigned|resignation/);
      expect(reasonFor('AS0055')).toMatch(/no longer with us/);
      expect(reasonFor('AS0056')).not.toMatch(/resigned|resignation/);
      expect(reasonFor('AS0056')).toMatch(/archived/);
    });

    it('still names a resignation letter for someone who actually resigned', async () => {
      people = [person({ assayerCode: 'AS0202', lifecycleStatus: 'RESIGNED',
        exitDate: null, terminationDate: null })];

      await scan();

      const row = issues.scanner().find((r: any) => r.sourceColumn.startsWith('Left with no leaving date'));
      expect(row?.reason).toMatch(/is marked resigned/);
      expect(row?.reason).toMatch(/resignation or termination letter/);
    });
  });

  /**
   * Three classes that nothing surfaced before an independent audit counted them: 11 people with
   * no address, 13 with no phone (3 of them active), and 10,977 documents ticked as received on
   * the old spreadsheet with no scan behind them.
   *
   * Those are roster-wide totals. The checks themselves report fewer — 4 and 7 — because the two
   * "go and fill this in" checks are scoped to people still on the roster: chasing a phone number
   * for somebody who resigned two years ago is not work anyone should be handed.
   */
  describe('gaps nothing used to report', () => {
    it('raises a person with no home address, whose pin can never resolve', async () => {
      people = [person({ assayerCode: 'AS0100', address: '   ' })];

      await scan();

      const row = issues.scanner().find((r: any) => r.sourceColumn.startsWith('No home address'));
      expect(row?.reason).toMatch(/address lookup has nothing to read/);
    });

    it('raises a person with no phone, and says so more sharply when they are active', async () => {
      people = [person({ assayerCode: 'AS0101', phone: '', lifecycleStatus: 'ACTIVE' })];

      await scan();

      const row = issues.scanner().find((r: any) => r.sourceColumn.startsWith('No phone number'));
      expect(row?.reason).toMatch(/they are active, so work can be offered to them today/);
    });

    it('does not mention being active for someone who is not', async () => {
      people = [person({ assayerCode: 'AS0102', phone: '', lifecycleStatus: 'INACTIVE' })];

      await scan();

      const row = issues.scanner().find((r: any) => r.sourceColumn.startsWith('No phone number'));
      expect(row?.reason).not.toMatch(/they are active/);
    });
  });

  /**
   * The false negative an independent audit caught: a pin that exists but means nothing.
   *
   * "No home location on the map" tested only for NULL, so 9 live records slipped past it —
   * coordinates whose own stated accuracy is 100 km or 500 km, the centroid the geocoder falls
   * back to when it cannot resolve an address (`geo_source = 'none'`). Four were lifecycle ACTIVE.
   * Downstream nothing tells them from a real pin: the conflict-of-interest floor measures
   * against them and travel is costed from them. A wrong pin is worse than an absent one, because
   * the absent one fails visibly.
   */
  /**
   * An address that looks filled in and holds no place.
   *
   * `blankAddress` catches an empty cell; this catches the cell that reads as an address and is
   * not one. The two must not both fire on the same person, and neither should fire on an address
   * that merely failed to resolve today — that one may resolve tomorrow as OSM fills in, and it is
   * `placeholderPin`'s business.
   */
  describe('an address with no place in it', () => {
    const raise = (rows: any[]) => rows.find((r: any) => r.sourceColumn.startsWith('Home address has no place'));

    it('raises an address that is only a relative and a door number', async () => {
      people = [person({ assayerCode: 'AS0900', address: 'S/O Ramesh Kumar, H.No-110' })];

      await scan();

      const row = raise(issues.scanner());
      expect(row).toBeDefined();
      expect(row.sourceColumn).toContain('AS0900');
      // The clerk has to see what is actually in the cell to know what is missing from it.
      expect(row.rawValue).toBe('S/O Ramesh Kumar, H.No-110');
      expect(row.reason).toMatch(/nothing in it names a place/);
      expect(row.reason).toMatch(/Add the locality or road/);
    });

    it('raises an address that is only a landmark', async () => {
      people = [person({ assayerCode: 'AS0901', address: 'Near Bus Stand' })];
      await scan();
      expect(raise(issues.scanner())).toBeDefined();
    });

    it('leaves a real address alone, however coarsely it happens to resolve', async () => {
      people = [person({ assayerCode: 'AS0902', address: '81, Sunaro Ka Bass, Satlana, Jodhpur, Rajasthan-342802' })];
      await scan();
      expect(raise(issues.scanner())).toBeUndefined();
    });

    it('leaves an empty address to the check that is about empty addresses', async () => {
      people = [person({ assayerCode: 'AS0903', address: '' })];

      await scan();

      expect(raise(issues.scanner())).toBeUndefined();
      expect(issues.scanner().some((r: any) => r.sourceColumn.startsWith('No home address'))).toBe(true);
    });
  });

  /**
   * The two findings the identity work adds, and the shapes they deliberately take.
   *
   * A rejected document is per person because each is a different card that a different human has
   * to chase. A missing photograph is aggregate because the answer is the same for everybody in the
   * class, and a thousand copies of one decision would bury the findings that each need a
   * different record looked at.
   */
  describe('identity findings', () => {
    const rejectedRow = (over: Record<string, unknown> = {}) => ({
      assayerId: 'id-AS0900', requirement: 'AADHAAR_FRONT',
      verificationStatus: 'REJECTED', rejectionReason: 'ILLEGIBLE', ...over,
    });

    it('raises a sent-back document per person, in the words the reviewer chose', async () => {
      people = [person({ assayerCode: 'AS0900' })];
      rejectedDocs = [rejectedRow()];

      await scan();

      const row = issues.scanner().find((r: any) => r.sourceColumn.startsWith('Identity document sent back'));
      expect(row).toBeDefined();
      expect(row.sourceColumn).toContain('AS0900');
      expect(row.rawValue).toBe('Too blurred or dark to read');
      // It must say who is waiting and what it blocks, or the desk has no reason to work it.
      expect(row.reason).toMatch(/told on their phone/);
      expect(row.reason).toMatch(/cannot be activated/);
    });

    it('survives a rejection whose reason predates the reason column', async () => {
      people = [person({ assayerCode: 'AS0901' })];
      rejectedDocs = [rejectedRow({ assayerId: 'id-AS0901', rejectionReason: null })];

      await scan();

      const row = issues.scanner().find((r: any) => r.sourceColumn.startsWith('Identity document sent back'));
      expect(row.rawValue).toMatch(/no reason was recorded/);
    });

    it('says nothing once a replacement has arrived', async () => {
      // `attachFile` clears the rejection, so this finding closes itself without anyone working it.
      people = [person({ assayerCode: 'AS0902' })];
      rejectedDocs = [];

      await scan();

      expect(issues.scanner().some((r: any) => r.sourceColumn.startsWith('Identity document sent back'))).toBe(false);
    });

    it('reports missing photographs as one row, not one per person', async () => {
      people = [
        person({ assayerCode: 'AS0903', photograph: null }),
        person({ assayerCode: 'AS0904', photograph: '' }),
        person({ assayerCode: 'AS0905' }),
      ];

      await scan();

      const rows = issues.scanner().filter((r: any) => r.sourceColumn.startsWith('No photograph'));
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toMatch(/2 of 3/);
      // It has to say the appraiser can fix it themselves, or the desk starts chasing photographs.
      expect(rows[0].reason).toMatch(/from the app/);
    });

    it('says nothing when everybody has a photograph', async () => {
      people = [person({ assayerCode: 'AS0906' })];
      await scan();
      expect(issues.scanner().some((r: any) => r.sourceColumn.startsWith('No photograph'))).toBe(false);
    });
  });

  describe('a home pin that is a placeholder rather than a home', () => {
    it('raises a person pinned to a 100 km centroid, which the NULL check misses', async () => {
      people = [person({ assayerCode: 'AD0104', latitude: 23.94, longitude: 91.98,
        geoAccuracyMeters: 100_000, geoSource: 'none' })];

      await scan();

      const row = issues.scanner().find((r: any) => r.sourceColumn.startsWith('Home pin is a placeholder'));
      expect(row).toBeDefined();
      expect(row.sourceColumn).toContain('AD0104');
      expect(row.rawValue).toBe('accurate to about 100 km');
      expect(row.reason).toMatch(/only accurate to about 100 km/);
      // Says what to do, in words a clerk can act on — not "geo_accuracy_meters exceeds threshold".
      expect(row.reason).toMatch(/set the pin|correct the address/);
    });

    it('raises the 500 km country-centre fallback too', async () => {
      people = [person({ assayerCode: 'AS0841', latitude: 21.14, longitude: 79.08,
        geoAccuracyMeters: 500_000, geoSource: 'none' })];

      await scan();

      expect(issues.scanner().some((r: any) => r.sourceColumn.startsWith('Home pin is a placeholder'))).toBe(true);
    });

    /**
     * The boundary decides whether this check is noise. A real address resolves to metres or a
     * few km; nothing legitimate sits near 100 km. These two prove the line does not creep down
     * onto ordinary pins.
     */
    it('leaves an ordinary pin alone', async () => {
      people = [person({ assayerCode: 'AS0002', geoAccuracyMeters: 60, geoSource: 'geocoder' })];

      await scan();

      expect(issues.scanner().some((r: any) => r.sourceColumn.startsWith('Home pin is a placeholder'))).toBe(false);
    });

    it('leaves a merely imprecise pincode pin alone', async () => {
      people = [person({ assayerCode: 'AS0003', geoAccuracyMeters: 3_000, geoSource: 'pincode' })];

      await scan();

      expect(issues.scanner().some((r: any) => r.sourceColumn.startsWith('Home pin is a placeholder'))).toBe(false);
    });

    /** A person with NO pin is the other check's business — they must not be raised twice. */
    it('does not double-report someone who has no pin at all', async () => {
      people = [person({ assayerCode: 'AS0004', latitude: null, longitude: null })];

      await scan();

      expect(issues.scanner().some((r: any) => r.sourceColumn.startsWith('Home pin is a placeholder'))).toBe(false);
    });
  });

  it('creates ZERO new rows on a second scan over unchanged data — the panel must not grow by rescanning', async () => {
    people = [
      person({ assayerCode: 'AS0001', dateOfBirth: '4032-01-01' }),                    // corrupt date
      person({ assayerCode: 'AS0002', joiningDate: '2024-06-10', exitDate: '2024-05-14', lifecycleStatus: 'RESIGNED' }),
      person({ assayerCode: 'AS0003', dateOfBirth: null, region: null }),              // two defects
      person({ assayerCode: 'AS0004', panNumber: 'ABCDE1234F' }),
      person({ assayerCode: 'AS0005', panNumber: 'ABCDE1234F' }),                      // duplicate pair
      person({ assayerCode: 'AS0006', latitude: null, longitude: null }),              // aggregate member
    ];

    const first = await scan();
    const after = issues.scanner().length;
    expect(first.inserted).toBe(after);
    expect(after).toBeGreaterThanOrEqual(6);

    const second = await scan();
    expect(second.inserted).toBe(0);
    expect(second.reopened).toBe(0);
    expect(second.updated).toBe(0);
    expect(issues.scanner()).toHaveLength(after);
  });

  it('refreshes an open finding in place when its facts move — never a second open row for one defect', async () => {
    people = [person({ assayerCode: 'AS0001', joiningDate: '2024-06-10', exitDate: '2024-05-14', lifecycleStatus: 'RESIGNED' })];
    await scan();

    (people[0] as any).exitDate = '2024-04-30'; // still contradictory, different value
    const second = await scan();

    expect(second.updated).toBe(1);
    const rows = issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.joinedAfterLeft));
    expect(rows).toHaveLength(1);
    expect(rows[0].rawValue).toContain('30 Apr 2024');
    expect(rows[0].resolvedAt).toBeNull();
  });

  // ── Resolutions: kept, and reopened only when the facts change ───────────

  it('never reopens or rewrites a finding a person resolved while the facts are unchanged', async () => {
    people = [person({ assayerCode: 'AS0001', dateOfBirth: null })];
    await scan();

    const row = issues.scanner()[0];
    row.resolvedAt = new Date();
    row.resolvedBy = 'user-9';
    row.resolution = 'Asked; they will not share it. Accepted.';

    const second = await scan();

    expect(second.skippedResolved).toBe(1);
    expect(second.inserted).toBe(0);
    expect(issues.scanner()).toHaveLength(1);
    expect(issues.scanner()[0].resolution).toBe('Asked; they will not share it. Accepted.');
  });

  it('cuts a NEW generation when the data changes after a person resolved — the old decision stays on the record', async () => {
    people = [person({ assayerCode: 'AS0001', joiningDate: '2024-06-10', exitDate: '2024-05-14', lifecycleStatus: 'RESIGNED' })];
    await scan();

    const gen0 = issues.scanner()[0];
    gen0.resolvedAt = new Date();
    gen0.resolvedBy = 'user-9';
    gen0.resolution = 'Joining letter says 10 Jun — exit corrected.';

    // ...but the correction was made to the wrong field, leaving a different contradiction.
    (people[0] as any).exitDate = '2024-01-01';
    const second = await scan();

    expect(second.reopened).toBe(1);
    const rows = issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.joinedAfterLeft));
    expect(rows).toHaveLength(2);
    const byGen = [...rows].sort((a, b) => a.sourceRow - b.sourceRow);
    expect(byGen[0].sourceRow).toBe(0);
    expect(byGen[0].resolution).toBe('Joining letter says 10 Jun — exit corrected.'); // untouched
    expect(byGen[1].sourceRow).toBe(1);
    expect(byGen[1].resolvedAt).toBeNull();
  });

  // ── Auto-close ───────────────────────────────────────────────────────────

  it('closes an open finding whose defect is gone, as SYSTEM, with nobody named as the resolver', async () => {
    people = [person({ assayerCode: 'AS0001', region: null })];
    await scan();

    (people[0] as any).region = 'South';
    const second = await scan();

    expect(second.autoClosed).toBe(1);
    const row = issues.scanner()[0];
    expect(row.resolvedAt).not.toBeNull();
    expect(row.resolvedBy).toBeNull();
    expect(row.resolution).toBe(AUTO_CLOSE_RESOLUTION);
    expect(row.updatedBy).toBe('SYSTEM');
  });

  it('reopens over an auto-close when the defect returns — a machine statement of fact is not a decision', async () => {
    people = [person({ assayerCode: 'AS0001', region: null })];
    await scan();
    (people[0] as any).region = 'South';
    await scan(); // auto-closed

    (people[0] as any).region = null; // the correction was reverted
    const third = await scan();

    expect(third.reopened).toBe(1);
    const rows = issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.noRegion));
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.resolvedAt === null && r.sourceRow === 1)).toBe(true);
  });

  it("never touches the importer's rows — auto-close is scoped to the scanner's own sheet", async () => {
    issues.seed({
      sourceSheet: 'Assayers', sourceColumn: 'Active / Inactive', sourceRow: 12,
      rawValue: '???', reason: 'Could not be read.', resolvedAt: null,
    });
    people = [person({ assayerCode: 'AS0001' })]; // nothing wrong: every scanner column unclaimed

    await scan();

    const importerRow = issues.rows.find((r) => r.sourceSheet === 'Assayers');
    expect(importerRow.resolvedAt).toBeNull();
    expect(importerRow.resolution).toBeUndefined();
  });

  // ── Suppression: one real-world problem, one queue entry ─────────────────

  it('skips a duplicate pair the importer already queued, resolved or not, and still writes the pairs it alone can see', async () => {
    issues.seed({
      sourceSheet: 'Assayers', sourceColumn: 'Duplicate PAN', sourceRow: 40,
      rawValue: 'AD0001 and AD0002', reason: 'importer text',
      resolvedAt: new Date(), resolvedBy: 'user-1', resolution: 'same person; AD0002 retired',
    });
    people = [
      person({ assayerCode: 'AD0001', panNumber: 'ABCDE1234F', aadhaarNumber: '123456789012' }),
      person({ assayerCode: 'AD0002', panNumber: 'ABCDE1234F', aadhaarNumber: '123456789012' }),
    ];

    const summary = await scan();

    expect(summary.suppressed).toBe(1); // the PAN pair — the importer owns it
    expect(issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.duplicatePan))).toHaveLength(0);
    // The Aadhaar duplicate has no importer counterpart, so the scanner must raise it.
    expect(issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.duplicateAadhaar))).toHaveLength(1);
  });

  /**
   * The importer takes the first code it meets IN FILE ORDER as the holder; this scan has no file
   * order and takes the lowest code. For two people that is the same pair either way, which is
   * all the live roster contains and why comparing pair strings looked correct. For three it is
   * not: a file ordered AS0300, AS0200, AS0100 leaves the importer holding
   * {'AS0200 and AS0300', 'AS0100 and AS0300'} while the scan produces
   * {'AS0100 and AS0200', 'AS0100 and AS0300'}. String comparison suppresses one of the two and
   * writes the other, so one three-way collision becomes three queue rows — and the extra row
   * restates, under a different pairing, facts a clerk has already been given.
   */
  it('suppresses a three-way duplicate the importer paired from the other end', async () => {
    issues.seed({
      sourceSheet: 'Assayers', sourceColumn: 'Duplicate PAN', sourceRow: 40,
      rawValue: 'AS0200 and AS0300', reason: 'importer text',
    });
    issues.seed({
      sourceSheet: 'Assayers', sourceColumn: 'Duplicate PAN', sourceRow: 41,
      rawValue: 'AS0100 and AS0300', reason: 'importer text',
    });
    people = [
      person({ assayerCode: 'AS0100', panNumber: 'ABCDE1234F' }),
      person({ assayerCode: 'AS0200', panNumber: 'ABCDE1234F' }),
      person({ assayerCode: 'AS0300', panNumber: 'ABCDE1234F' }),
    ];

    const summary = await scan();

    // Both of the scan's pairs are inside the group the importer already described.
    expect(summary.suppressed).toBe(2);
    expect(issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.duplicatePan))).toHaveLength(0);
  });

  it('still raises a duplicate against somebody the importer never connected', async () => {
    issues.seed({
      sourceSheet: 'Assayers', sourceColumn: 'Duplicate PAN', sourceRow: 40,
      rawValue: 'AS0100 and AS0200', reason: 'importer text',
    });
    people = [
      person({ assayerCode: 'AS0100', panNumber: 'ABCDE1234F' }),
      person({ assayerCode: 'AS0200', panNumber: 'ABCDE1234F' }),
      // Registered after the import, so no importer row names them at all.
      person({ assayerCode: 'AS0400', panNumber: 'ABCDE1234F' }),
    ];

    const summary = await scan();

    const raised = issues.scanner((r: any) => r.sourceColumn.startsWith(CHECK_TITLES.duplicatePan));
    expect(summary.suppressed).toBe(1);
    expect(raised.map((r: any) => r.rawValue)).toEqual(['AS0100 and AS0400']);
  });

  it("skips 'leaving date but still active' when the importer already queued that person's Exit Date cell", async () => {
    issues.seed({
      sourceSheet: 'Assayers', sourceColumn: 'Exit Date', sourceRow: 529,
      rawValue: '30-11-2025', reason: 'Has an exit date but the sheet marks them Active — settle which is true.',
      assayerId: 'id-AS0633', sourceAssayerCode: 'AS0633', resolvedAt: null,
    });
    people = [
      person({ assayerCode: 'AS0633', exitDate: '2025-11-30' }),               // importer has it
      person({ assayerCode: 'AS0700', exitDate: '2025-01-15' }),               // importer does not
    ];

    await scan();

    const rows = issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.leavingButActive));
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceColumn).toBe(`${CHECK_TITLES.leavingButActive} · AS0700`);
  });

  // ── Duplicates: repository-read, leak-guarded, importer vocabulary ───────

  it('names the two codes and NEVER the shared identifier in anything it writes', async () => {
    people = [
      person({ assayerCode: 'AS0100', panNumber: 'ABCDE1234F', bankAccountNumber: '9988776655', phone: '9876543210' }),
      person({ assayerCode: 'AS0200', panNumber: 'ABCDE1234F', bankAccountNumber: '9988776655', phone: '9876543210' }),
    ];

    await scan();

    const everything = JSON.stringify(issues.scanner());
    expect(everything).not.toContain('ABCDE1234F');
    expect(everything).not.toContain('9988776655');
    expect(everything).not.toContain('9876543210');
    const pan = issues.scanner((r) => r.sourceColumn === `${CHECK_TITLES.duplicatePan} · AS0200`);
    expect(pan).toHaveLength(1);
    expect(pan[0].rawValue).toBe('AS0100 and AS0200'); // the importer's exact pair vocabulary
  });

  /**
   * Anchored on the lowest code whatever order the rows arrive in — the people are handed over
   * here as AS0300, AS0100, AS0200 precisely so a pairing that followed input order would fail.
   * That determinism is what lets a re-scan recognise its own earlier rows instead of writing
   * new ones beside them.
   *
   * It is NOT the importer's rule, which anchors on the first code in the FILE. For two people
   * both rules give the same pair; for three they disagree, which is why suppression compares
   * connected groups rather than pair text.
   */
  it('pairs a three-way duplicate from the lowest code, whatever order the rows arrive in', async () => {
    people = [
      person({ assayerCode: 'AS0300', phone: '9000000001' }),
      person({ assayerCode: 'AS0100', phone: '9000000001' }),
      person({ assayerCode: 'AS0200', phone: '9000000001' }),
    ];

    await scan();

    const rows = issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.duplicatePhone));
    expect(rows.map((r) => r.rawValue).sort()).toEqual(['AS0100 and AS0200', 'AS0100 and AS0300']);
  });

  // ── Boundaries: one defect, one finding, zero false positives ────────────

  it('reports a corrupt date once — never a second time as an impossible age or a lifecycle contradiction', async () => {
    people = [
      person({ assayerCode: 'AD0088', dateOfBirth: '4032-01-01' }),
      // Year 6333 in the exit: comparing joining against it is not a real contradiction.
      person({ assayerCode: 'AS0266', joiningDate: '2023-08-18', exitDate: '5481-01-01', lifecycleStatus: 'RESIGNED' }),
    ];

    await scan();

    const columns = issues.scanner().map((r) => r.sourceColumn);
    expect(columns).toContain(`${CHECK_TITLES.corruptDate} · AD0088`);
    expect(columns).toContain(`${CHECK_TITLES.corruptDate} · AS0266`);
    expect(columns.some((c) => c.startsWith(CHECK_TITLES.impossibleAge))).toBe(false);
    expect(columns.some((c) => c.startsWith(CHECK_TITLES.joinedAfterLeft))).toBe(false);
    // Fixing the corrupt cell is what promotes the comparison — sequencing, not hiding.
    (people[1] as any).exitDate = '2023-01-01';
    await scan();
    expect(issues.scanner().map((r) => r.sourceColumn))
      .toContain(`${CHECK_TITLES.joinedAfterLeft} · AS0266`);
  });

  it('flags an implausible working age only on a real calendar date of birth', async () => {
    people = [
      person({ assayerCode: 'AS0494', dateOfBirth: `${thisYear - 10}-01-01` }),  // age ~10
      person({ assayerCode: 'AS0900', dateOfBirth: `${thisYear - 95}-01-01` }),  // age ~95
      person({ assayerCode: 'AS0901', dateOfBirth: `${thisYear - 40}-01-01` }),  // fine
    ];

    await scan();

    const rows = issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.impossibleAge));
    expect(rows.map((r) => r.sourceColumn).sort()).toEqual([
      `${CHECK_TITLES.impossibleAge} · AS0494`,
      `${CHECK_TITLES.impossibleAge} · AS0900`,
    ]);
    expect(rows.find((r) => r.sourceColumn.endsWith('AS0494'))!.reason).toContain('too young');
  });

  it('treats a termination date as a leaving date — resigned with one recorded is not "left with no date"', async () => {
    people = [
      person({ assayerCode: 'AS0001', lifecycleStatus: 'RESIGNED' }),                                  // no date at all
      person({ assayerCode: 'AS0002', lifecycleStatus: 'TERMINATED', terminationDate: '2024-02-01' }), // dated
    ];

    await scan();

    const rows = issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.leftNoDate));
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceColumn).toBe(`${CHECK_TITLES.leftNoDate} · AS0001`);
  });

  it('reports someone left but still actively empanelled, naming the client', async () => {
    people = [person({ assayerCode: 'AS0001', lifecycleStatus: 'RESIGNED', exitDate: '2024-01-31' })];
    empanelmentRows = [{ assayerId: 'id-AS0001', status: 'ACTIVE', client: { name: 'ICICI Bank' } }];

    await scan();

    const rows = issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.leftButEmpanelled));
    expect(rows).toHaveLength(1);
    expect(rows[0].rawValue).toContain('ICICI Bank');
  });

  // ── Aggregates: one row for the whole class ──────────────────────────────

  it('writes ONE row for everyone with no home coordinate, and keeps its count fresh without cutting generations', async () => {
    people = [
      person({ assayerCode: 'AS0001', latitude: null, longitude: null }),
      person({ assayerCode: 'AS0002', latitude: null, longitude: null }),
      person({ assayerCode: 'AS0003', latitude: null, longitude: null }),
      person({ assayerCode: 'AS0004' }),
    ];

    await scan();
    let rows = issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.noCoordinates));
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceColumn).toBe(CHECK_TITLES.noCoordinates); // no code suffix — it is about the class
    expect(rows[0].reason).toContain('3 of 4');

    // The geo backfill places one person: the count moves, the row does not multiply.
    (people[0] as any).latitude = 19.1; (people[0] as any).longitude = 72.8;
    const second = await scan();
    rows = issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.noCoordinates));
    expect(second.inserted).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toContain('2 of 4');
    expect(rows[0].rawValue).toBe('no home coordinate'); // stable — a falling counter must not reopen decisions
  });

  it('raises the never-verified-documents row only while not one document has ever been verified', async () => {
    people = [person({ assayerCode: 'AS0001' })];
    receivedDocs = 10977;
    verifiedDocs = 0;
    issues.docHolders = 1141;

    await scan();
    const rows = issues.scanner((r) => r.sourceColumn === CHECK_TITLES.docsNeverVerified);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toContain('10,977');
    expect(rows[0].reason).toContain('1,141');

    // The first real verification ends the "never operated" fact — the report closes itself.
    verifiedDocs = 1;
    const second = await scan();
    expect(second.autoClosed).toBe(1);
    expect(issues.scanner((r) => r.sourceColumn === CHECK_TITLES.docsNeverVerified)[0].resolution)
      .toBe(AUTO_CLOSE_RESOLUTION);
  });

  // ── The repair backup: a courtesy clause behind a guard ──────────────────

  it('tells the clerk what a blanked date was misread as, when the repair backup table exists', async () => {
    issues.backupRows = [
      { assayer_code: 'AS0001', old_date_of_birth: '4032-01-01', old_exit_date: null },
      { assayer_code: 'AS0002', old_date_of_birth: null, old_exit_date: '5481-01-01' },
    ];
    people = [
      person({ assayerCode: 'AS0001', dateOfBirth: null }),
      person({ assayerCode: 'AS0002', lifecycleStatus: 'RESIGNED' }),
    ];

    await scan();

    const dob = issues.scanner((r) => r.sourceColumn === `${CHECK_TITLES.noDob} · AS0001`)[0];
    expect(dob.reason).toContain('misread as 4032-01-01');
    const exit = issues.scanner((r) => r.sourceColumn === `${CHECK_TITLES.leftNoDate} · AS0002`)[0];
    expect(exit.reason).toContain('misread as 5481-01-01');
  });

  it('stands the findings without the clause when the backup table was dropped — and never queries it', async () => {
    issues.backupRows = null; // to_regclass says the table is gone
    people = [person({ assayerCode: 'AS0001', dateOfBirth: null })];

    await scan();

    const row = issues.scanner((r) => r.sourceColumn === `${CHECK_TITLES.noDob} · AS0001`)[0];
    expect(row.reason).not.toContain('misread');
    expect(issues.queryLog.some((sql) => sql.includes('FROM _fix_backup_corrupt_dates'))).toBe(false);
  });

  // ── The key cannot overflow ──────────────────────────────────────────────

  it('keeps every source_column under varchar(120) even for the longest legal appraiser code', () => {
    const longestCode = 'X'.repeat(50); // assayer_code is varchar(50)
    for (const title of Object.values(CHECK_TITLES)) {
      // Titles are identity: ≤ 45 chars means title + ' · ' + code ≤ 98, so the column can
      // never be truncated by varchar(120) into a collision between two different findings.
      expect(title.length).toBeLessThanOrEqual(45);
      expect(`${title} · ${longestCode}`.length).toBeLessThanOrEqual(120);
    }
  });

  // ── Query count is flat, not O(findings) ─────────────────────────────────

  /**
   * The whole point of `writeFindings`/`autoClose` being bulk operations: one 133-finding sweep
   * used to cost 7,719 `manager.query`/`save` calls on the dev DB (2 per finding: a `findOne`
   * then a `save`) plus one `save` per auto-closed row. A single DISTINCT-ON read plus at most
   * one INSERT and one UPDATE must cover the whole batch regardless of how many findings or
   * closures are in it — asserted here by running the same check at two very different finding
   * counts and requiring the bulk-call counters not to move.
   */
  it('writes any number of findings in the same fixed number of bulk queries — not one pair per finding', async () => {
    const many = Array.from({ length: 40 }, (_, i) => person({
      assayerCode: `AS${String(i).padStart(4, '0')}`, region: null,
      phone: `9${String(1000000 + i).padStart(9, '0')}`, // distinct — a shared default would also raise duplicate-phone findings
    }));

    people = [person({ assayerCode: 'AS9000', region: null })];
    await scan();
    const oneFindingReads = issues.bulkReadCalls;

    issues = new (issues.constructor as any)();
    const mod = await Test.createTestingModule({
      providers: [
        DataIntegrityService,
        { provide: getRepositoryToken(AssayerEntity), useValue: {
          find: jest.fn(async () => many),
          findOne: jest.fn(async (opts: any) => many.find((p) => p.id === opts.where.id) ?? null),
        } },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: { count: jest.fn(async () => 0), find: jest.fn(async () => []) } },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: { find: jest.fn(async () => []) } },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: issues },
      ],
    }).compile();
    const manyScanService: DataIntegrityService = mod.get(DataIntegrityService);
    const manySummary = await manyScanService.scan();

    expect(manySummary.findings).toBe(40); // 40 distinct "No region" findings this time
    expect(issues.bulkReadCalls).toBe(oneFindingReads); // one bulk read either way
    expect(issues.bulkUpdateCalls).toBe(0); // both runs are pure inserts, so no UPDATE at all
  });

  // ── The narrow column list `select` reads ────────────────────────────────

  it('asks the assayers repository for a select list, not the whole ~80-column entity', async () => {
    const assayersRepo: any = { find: jest.fn(async () => []), findOne: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        DataIntegrityService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayersRepo },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: { count: jest.fn(async () => 0) } },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: { find: jest.fn(async () => []) } },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: new (issues.constructor as any)() },
      ],
    }).compile();
    await mod.get(DataIntegrityService).scan();

    expect(assayersRepo.find).toHaveBeenCalledTimes(1);
    const opts = assayersRepo.find.mock.calls[0][0];
    expect(Array.isArray(opts.select)).toBe(true);
    // The full entity carries far more columns than this — the point is that it is narrowed at all.
    expect(opts.select.length).toBeLessThan(30);
    expect(opts.select).toEqual(expect.arrayContaining(['panNumber', 'aadhaarNumber', 'bankAccountNumber']));
  });

  // ── The incremental path shares the same check logic as the full sweep ──

  describe('incrementalScan', () => {
    it('raises the same finding for one edited person as the full sweep would', async () => {
      people = [person({ assayerCode: 'AS0001', region: null })];

      const summary = await service.incrementalScan('id-AS0001');

      expect(summary.inserted).toBe(1);
      const rows = issues.scanner();
      expect(rows).toHaveLength(1);
      expect(rows[0].sourceColumn).toBe(`${CHECK_TITLES.noRegion} · AS0001`);
    });

    it('closes only that person\'s own finding when the defect is fixed, leaving everyone else alone', async () => {
      people = [
        person({ assayerCode: 'AS0001', region: null }),
        person({ assayerCode: 'AS0002', region: null }),
      ];
      await scan(); // full sweep seeds both open findings

      (people[0] as any).region = 'West'; // AS0001's gap is fixed
      const summary = await service.incrementalScan('id-AS0001');

      expect(summary.autoClosed).toBe(1);
      const stillOpenFor2 = issues.scanner(
        (r) => r.sourceColumn === `${CHECK_TITLES.noRegion} · AS0002` && !r.resolvedAt,
      );
      expect(stillOpenFor2).toHaveLength(1); // untouched by AS0001's incremental run
      const closedFor1 = issues.scanner((r) => r.sourceColumn === `${CHECK_TITLES.noRegion} · AS0001`)[0];
      expect(closedFor1.resolvedAt).not.toBeNull();
    });

    it('finds a duplicate PAN against the roster without recomputing every check over everyone', async () => {
      people = [
        person({ assayerCode: 'AS0001', panNumber: 'ABCDE1234F', phone: '9111111111' }),
        person({ assayerCode: 'AS0002', panNumber: 'ABCDE1234F', phone: '9222222222' }),
      ];

      const summary = await service.incrementalScan('id-AS0002');

      expect(summary.inserted).toBe(1);
      const rows = issues.scanner((r) => r.sourceColumn.startsWith(CHECK_TITLES.duplicatePan));
      expect(rows).toHaveLength(1);
      expect(rows[0].rawValue).toBe('AS0001 and AS0002');
    });

    it('never writes the two aggregate, population-wide checks', async () => {
      people = [person({ assayerCode: 'AS0001', latitude: null, longitude: null })];

      await service.incrementalScan('id-AS0001');

      expect(issues.scanner((r) => r.sourceColumn === CHECK_TITLES.noCoordinates)).toHaveLength(0);
    });

    it('does nothing for a person who no longer exists — the full sweep is the backstop', async () => {
      people = [];
      const summary = await service.incrementalScan('missing-id');
      expect(summary.findings).toBe(0);
      expect(issues.rows).toHaveLength(0);
    });
  });
});

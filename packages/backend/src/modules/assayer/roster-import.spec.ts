import * as xlsx from 'xlsx';
import { ONBOARDING_DOCUMENT_COLUMNS, ONBOARDING_DOCUMENT_LABELS, OnboardingDocument } from '@fapoms/shared';
import { RosterImportService } from './roster-import.service';
import { AssayerService } from './assayer.service';

/**
 * The gate for "template ↔ importer are in sync".
 *
 * `AssayerService.generateTemplate()` publishes the download-and-fill template.
 * `RosterImportService.importAssayerSheet()` is what the Import button runs. If the template ships
 * a column the importer does not read, a person fills it in and the data silently vanishes — the
 * exact failure this pair of files exists to prevent.
 *
 * So: generate the real template, put ONE filled sample row under EVERY column it ships, and run
 * that workbook through the real importer (as a rehearsal — `dryRun`). Every column must be read
 * and mapped: the row is read, nothing is skipped, no cell raises a review issue, and the related
 * tables (references, documents, background check, empanelment) each receive what the row carried.
 * If a template column is not one the importer reads, one of these counts falls short and the test
 * fails.
 */
describe('the roster template round-trips through the importer', () => {
  /** Every non-empty onboarding-document column the importer reads — 18 of the 21 requirements. */
  const documentLabels = new Set(
    (Object.keys(ONBOARDING_DOCUMENT_COLUMNS) as OnboardingDocument[])
      .filter((doc) => ONBOARDING_DOCUMENT_COLUMNS[doc])
      .map((doc) => ONBOARDING_DOCUMENT_LABELS[doc]),
  );
  const expectedDocumentCount = documentLabels.size;

  /**
   * A sample cell for one column, chosen so nothing is left unreadable: valid mobile numbers, a
   * real zone, a readable availability cell, recognised check outcomes. A document column gets a
   * plain "Yes" so it is actually recorded. Everything else is free text the importer stores as-is.
   */
  function sampleFor(header: string): string {
    const specific: Record<string, string> = {
      'Appraiser code': 'AS9001',
      'Appraiser Name': 'Shinil T',
      'PAN Number': 'ABCDE1234F',
      'Aadhaar Card Number': '123412341234',
      'Date of Birth': '1980-05-05',
      'Qualification': 'B.Com',
      'VSTS Code': 'VSTS-9001',
      'Phone Number 1': '9876543210',
      'Phone Number 2': '9876500011',
      'Email ID': 'shinil@example.com',
      'Residence Address': '12 MG Road, Kunnamangalam, Kozhikode',
      'Location': 'Kunnamangalam',
      'District': 'Kozhikode',
      'State': 'Kerala',
      'Zone': 'South',
      'Bank Name': 'State Bank of India',
      'Account Number': '00112233445566',
      'IFSC Code': 'SBIN0001234',
      'Joining Date': '2015-06-01',
      'Exit Date': '2024-01-31',
      'HR Name': 'Anita R',
      'Total Experience': '20 Years',
      'Active / Inactive': 'Active / Regular',
      // An exit date beside "Active" is a contradiction the importer now flags; the sample row
      // must be a coherent person, and this one has left.
      'Status': 'Resigned',
      'Remarks': 'Reliable, prefers local work.',
      'Reference 1 Name': 'Ramesh K',
      'Reference 1 Contact': '9800000001',
      'Reference 2 Name': 'Suresh M',
      'Reference 2 Contact': '9800000002',
      'NDA Hard Copy Status': 'Bangalore office',
      'Background Verification Done': 'Clear',
      'CIBIL Status': 'Good',
      'CIBIL Score': '750',
      'CIBIL Date': '2025-01-15',
      'ICICI Status': 'Recommended',
      'ICICI Documents Required': 'PAN copy',
      'Project Name': 'ICICI',
      'Link for Document': 'https://drive.google.com/drive/folders/sample',
      'Courier Date / Tracking number': '23-03-2026 / India Post / RX1234',
    };
    if (header in specific) return specific[header];
    if (documentLabels.has(header)) return 'Yes';
    return 'Sample';
  }

  /**
   * A UnitOfWork whose `run` executes the work against an in-memory manager. Nothing is persisted;
   * we only need the importer to be able to read the clients map and write its entities somewhere.
   * The one client the roster names — ICICI — is present, so the empanelment column maps to a
   * standing rather than being counted as a missing client.
   */
  function mockUow() {
    let idCounter = 1;
    const clients = [{ id: 'client-icici', name: 'ICICI Bank Ltd', displayName: 'ICICI' }];
    // Empanelments are remembered so the create-only working-banks path sees what the ICICI
    // path already wrote for the same (assayer, client) pair — as the real database would.
    const empanelments = new Map<string, any>();
    const manager = {
      find: async () => clients,
      // The importer's one-query prefetch of the appraisers already on the roster. Nothing is
      // seeded, so every row here is a creation.
      createQueryBuilder: () => {
        const qb: any = { where: () => qb, andWhere: () => qb, getMany: async () => [] };
        return qb;
      },
      // The savepoint each insert is wrapped in. Nothing to roll back in memory.
      query: async () => undefined,
      findOne: async (entity: any, query: any) => {
        if (entity?.name === 'AssayerClientEmpanelmentEntity') {
          const w = query?.where ?? {};
          return empanelments.get(`${w.assayerId}|${w.clientId}`);
        }
        return undefined;
      },
      create: (_entity: unknown, obj: Record<string, any>) => ({ ...obj }),
      save: async (entity: any, obj: any) => {
        if (obj && obj.id == null) obj.id = `id-${idCounter++}`;
        if (entity?.name === 'AssayerClientEmpanelmentEntity') {
          empanelments.set(`${obj.assayerId}|${obj.clientId}`, obj);
        }
        return obj;
      },
    };
    return { run: (work: (m: any, emit: any) => Promise<any>) => work(manager, () => {}) };
  }

  /** Auto-create is a settings knob; the round-trip runs with it ON, as shipped. */
  function mockSettings() {
    return { get: jest.fn().mockResolvedValue(true) };
  }

  /** The precision hand-off is fire-and-forget; the import must not depend on it resolving. */
  function mockGeoPrecision() {
    return { enqueueBackfill: jest.fn().mockResolvedValue(undefined) };
  }

  it('reads and maps every column the template ships', async () => {
    // The real template, generated the same way the download button does.
    const templateBuffer = await (AssayerService.prototype.generateTemplate as any).call({});
    const templateWb = xlsx.read(templateBuffer, { type: 'buffer' });
    const headers = (xlsx.utils.sheet_to_json(templateWb.Sheets.Assayers, { header: 1 })[0] ?? []) as string[];
    expect(headers.length).toBeGreaterThan(40);

    // One filled row under every column.
    const row: Record<string, string> = {};
    for (const header of headers) row[header] = sampleFor(header);

    const filled = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(filled, xlsx.utils.json_to_sheet([row], { header: headers }), 'Assayers');
    const filledBuffer = Buffer.from(xlsx.write(filled, { type: 'buffer', bookType: 'xlsx' }));

    const service = new RosterImportService(mockUow() as any, mockGeoPrecision() as any, mockSettings() as any);
    const summary = await service.importAssayerSheet(filledBuffer, 'test-user', { dryRun: true });

    // The row was read, placed, and nothing was refused or left unreadable.
    expect(summary.rowsRead).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.created).toBe(1);
    expect(summary.issues).toBe(0);
    expect(summary.notes).toEqual([]);
    expect(summary.dryRun).toBe(true);

    // The aux columns actually mapped — this is what a missing read-alias would break.
    expect(summary.references).toBe(2);
    // +1: the courier reference for the ethical-conduct letter is a document-record write of
    // its own (the letter's Yes/No cell is already counted among the columns).
    expect(summary.onboardingDocuments).toBe(expectedDocumentCount + 1);
    expect(summary.backgroundChecks).toBe(1);
    expect(summary.empanelments).toBe(1);
  });


  /**
   * A blank Zone must not make somebody invisible.
   *
   * `region` is what `findAll` scopes every roster read by, so a null one removes the person
   * from a region-scoped desk's roster, map and capacity tile while their own record looks
   * complete. The state already says where they are; the importer now falls back to it, the
   * way `create()` always has.
   */
  it('derives the region from the state when the Zone column is blank', async () => {
    const templateBuffer = await (AssayerService.prototype.generateTemplate as any).call({});
    const templateWb = xlsx.read(templateBuffer, { type: 'buffer' });
    const headers = (xlsx.utils.sheet_to_json(templateWb.Sheets.Assayers, { header: 1 })[0] ?? []) as string[];

    const row: Record<string, string> = {};
    for (const header of headers) row[header] = sampleFor(header);
    row['Zone'] = '';
    row['State'] = 'Kerala';

    const saved: any[] = [];
    const uow = mockUow();
    const inner = uow.run;
    uow.run = (work: any) => inner(async (m: any, emit: any) => {
      const origSave = m.save;
      m.save = async (entity: any, obj: any) => {
        const out = await origSave(entity, obj);
        if (obj?.assayerCode) saved.push(out);
        return out;
      };
      return work(m, emit);
    });

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet([row], { header: headers }), 'Assayers');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const service = new RosterImportService(uow as any, mockGeoPrecision() as any, mockSettings() as any);
    await service.importAssayerSheet(buffer, 'test-user', { dryRun: true });

    expect(saved.length).toBeGreaterThan(0);
    // Kerala sits in the South region — the point is that it is not null.
    expect(saved[0].region).toBeTruthy();
  });

  it('skips a row with no appraiser code, and only for that reason', async () => {
    const templateBuffer = await (AssayerService.prototype.generateTemplate as any).call({});
    const templateWb = xlsx.read(templateBuffer, { type: 'buffer' });
    const headers = (xlsx.utils.sheet_to_json(templateWb.Sheets.Assayers, { header: 1 })[0] ?? []) as string[];

    const row: Record<string, string> = {};
    for (const header of headers) row[header] = sampleFor(header);
    row['Appraiser code'] = ''; // the one field the importer refuses a row for

    const filled = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(filled, xlsx.utils.json_to_sheet([row], { header: headers }), 'Assayers');
    const filledBuffer = Buffer.from(xlsx.write(filled, { type: 'buffer', bookType: 'xlsx' }));

    const service = new RosterImportService(mockUow() as any, mockGeoPrecision() as any, mockSettings() as any);
    const summary = await service.importAssayerSheet(filledBuffer, 'test-user', { dryRun: true });

    expect(summary.rowsRead).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.created).toBe(0);
  });
});

/**
 * Finding the roster inside a real workbook.
 *
 * `importAssayerSheet` used to read `workbook.Sheets['Assayers']` and throw a bare `Error` when
 * there wasn't one — which Nest turns into a **500**, so the operator saw "Internal server error"
 * while the sentence naming the sheets their file *did* contain went to the server log. The real
 * client workbook has the branch list first and the roster second, on a sheet called `Assayer `
 * with a trailing space, so the everyday file failed this way.
 *
 * These were proved once already, against the `/assayers/upload` importer that this one replaced.
 * That importer is deleted; the behaviour it was covering for is not, so the tests move here.
 */
describe('RosterImportService — finding the roster sheet', () => {
  const mockSettings = () => ({ get: jest.fn().mockResolvedValue(false) });
  const mockGeoPrecision = () => ({ enqueueBackfill: jest.fn().mockResolvedValue(undefined) });
  const mockUow = () => ({
    run: jest.fn(async (fn: any) => fn({
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      // The prefetch of existing appraisers, and the savepoint each insert is wrapped in.
      createQueryBuilder: jest.fn(() => {
        const qb: any = { where: () => qb, andWhere: () => qb, getMany: async () => [] };
        return qb;
      }),
      query: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((_e: any, v: any) => v),
      save: jest.fn(async (_e: any, v: any) => ({ id: 'a-1', ...v })),
      getRepository: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(null), find: jest.fn().mockResolvedValue([]) })),
    })),
  });
  const service = () =>
    new RosterImportService(mockUow() as any, mockGeoPrecision() as any, mockSettings() as any);

  const book = (sheets: Array<[string, any[][]]>): Buffer => {
    const wb = xlsx.utils.book_new();
    for (const [name, aoa] of sheets) xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(aoa), name);
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };

  const BRANCH_SHEET: [string, any[][]] = ['Branch', [
    ['BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets'],
    ['BR-1', 'THENKURISSI', 'PALAKKAD', 'Kerala', 'Main Road', 120],
  ]];

  const ROSTER_ROWS: any[][] = [
    ['Appraiser Name', 'Appraiser code', 'Residence Address', 'Location', 'District', 'State', 'Zone'],
    ['Shinil T', 'AS0643', 'Thykkattu, Kunnamangalam, kerala-673571', 'Kunnamangalam', 'Calicut', 'Kerala', 'South'],
    ['R Jeganathan', 'AS0361', 'Anna Nagar, Chennai-600040', 'Chennai', 'Chennai', 'Tamil Nadu', 'South'],
  ];

  it('reads the roster from the second sheet, named "Assayer " with a trailing space', async () => {
    const summary = await service().importAssayerSheet(
      book([BRANCH_SHEET, ['Assayer ', ROSTER_ROWS]]), 'user-1', { dryRun: true },
    );

    expect(summary.rowsRead).toBe(2);
    expect(summary.created).toBe(2);
  });

  it('reads a roster whatever the sheet is called', async () => {
    const summary = await service().importAssayerSheet(
      book([BRANCH_SHEET, ['Appraisers FY26', ROSTER_ROWS]]), 'user-1', { dryRun: true },
    );

    expect(summary.created).toBe(2);
  });

  /**
   * Searching every sheet must not weaken the wrong-file guard: a workbook that is only a branch
   * list, uploaded here, has to be sent to the right screen rather than read as a roster of people
   * named after branches.
   */
  it('refuses a branch list as the wrong file, and says where it belongs', async () => {
    await expect(
      service().importAssayerSheet(book([BRANCH_SHEET]), 'user-1', { dryRun: true }),
    ).rejects.toThrow(/not the roster this screen imports/);
  });

  /**
   * A 400 the operator can read, not a 500. The old bare `throw new Error` lost the message
   * entirely — the one sentence that would have told them which sheets their file actually has.
   */
  it('answers a bad file with a client error carrying the headers it found', async () => {
    let caught: any;
    try {
      await service().importAssayerSheet(book([['Sheet1', [['Colour', 'Size'], ['red', 'L']]]]), 'user-1', { dryRun: true });
    } catch (e) { caught = e; }

    expect(caught?.getStatus?.()).toBe(400);
    expect(String(caught?.message)).toContain('Colour');
  });

  it('still honours an explicit sheet name when the caller gives one', async () => {
    const summary = await service().importAssayerSheet(
      book([BRANCH_SHEET, ['Assayer ', ROSTER_ROWS]]), 'user-1', { dryRun: true, sheetName: 'Assayer ' },
    );

    expect(summary.created).toBe(2);
  });
});

/**
 * The two ways this importer can duplicate a person, and what it does instead.
 *
 * One is the appraiser code: the roster's identity column, and the thing that makes a re-import an
 * update rather than a second copy of the workforce. The other is the person behind the code —
 * the same PAN, phone or email under two different codes, which is somebody registered twice and
 * is never merged automatically.
 *
 * They are opposite decisions on purpose. A matching code IS the same person, on the roster's own
 * terms, so the row updates. A matching PAN only *suggests* the same person, so it is reported and
 * a human decides — two brothers can share a phone, and a merge that guesses wrong destroys a real
 * person's history.
 */
describe('roster import — de-duplication', () => {
  const HEADERS = ['Appraiser Name', 'Appraiser code', 'PAN Number', 'Residence Address', 'Location', 'District', 'State'];

  const person = (name: string, code: string, pan = '') =>
    [name, code, pan, 'Main Road, Kunnamangalam', 'Kunnamangalam', 'Calicut', 'Kerala'];

  const book = (rows: any[][]): Buffer => {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([HEADERS, ...rows]), 'Assayer');
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };

  /**
   * A manager that records what was asked of it.
   *
   * `assayerLookups` is the point of one of these tests: however many rows the file has, the
   * importer must ask for the people in it exactly once — and every condition it puts on that
   * query is recorded, because which conditions are *absent* is the other thing under test.
   */
  const harness = (opts: {
    existing?: Array<Record<string, any>>;
    onSave?: (entity: any, obj: any) => void;
  } = {}) => {
    const existing = opts.existing ?? [];
    const assayerLookups: Array<{ conditions: string[]; codes: string[] }> = [];
    const queries: string[] = [];
    const savedAssayers: any[] = [];
    const savedIssues: any[] = [];
    let n = 1;

    const manager: any = {
      find: async () => [],
      createQueryBuilder: (entity: any) => {
        const conditions: string[] = [];
        let codes: string[] = [];
        const qb: any = {
          where: (sql: string, params?: any) => {
            conditions.push(sql);
            codes = params?.codes ?? codes;
            return qb;
          },
          getMany: async () => {
            if (entity?.name !== 'AssayerEntity') return [];
            assayerLookups.push({ conditions, codes });
            return existing.filter((a) => codes.includes(a.assayerCode));
          },
        };
        qb.andWhere = qb.where;
        return qb;
      },
      findOne: async () => undefined,
      query: async (sql: string) => { queries.push(sql); },
      create: (_entity: any, obj: any) => ({ ...obj }),
      save: async (entity: any, obj: any) => {
        opts.onSave?.(entity, obj);
        if (obj && obj.id == null) obj.id = `id-${n++}`;
        if (entity?.name === 'AssayerEntity') savedAssayers.push(obj);
        if (entity?.name === 'AssayerImportIssueEntity') savedIssues.push(obj);
        return obj;
      },
    };

    const service = new RosterImportService(
      { run: (work: any) => work(manager, () => {}) } as any,
      { enqueueBackfill: jest.fn().mockResolvedValue(undefined) } as any,
      // Auto-creation off, so no client stubs are minted and the notes hold only what these
      // tests are about.
      { get: jest.fn().mockResolvedValue(false) } as any,
    );

    return { service, assayerLookups, queries, savedAssayers, savedIssues };
  };

  /** What Postgres raises when a second writer aims at a taken `assayer_code`. */
  const uniqueViolation = () => {
    const err: any = new Error('duplicate key value violates unique constraint "UQ_assayers_code"');
    err.code = '23505';
    return err;
  };

  describe('the appraiser code — one query, and a race that does not kill the import', () => {
    /**
     * The prefetch replaced a `findOne` per row. On the real 1,155-row roster that was 1,155
     * queries for an answer one `IN (…)` gives — and this is the assertion that keeps it that
     * way, because reintroducing the per-row read would still pass every other test here.
     */
    it('asks for everyone in the file once, not once per row', async () => {
      const h = harness({ existing: [{ id: 'a-1', assayerCode: 'AS0643' }, { id: 'a-2', assayerCode: 'AS0361' }] });

      const summary = await h.service.importAssayerSheet(
        book([person('Shinil T', 'AS0643'), person('R Jeganathan', 'AS0361'), person('Vijay V', 'AD0117')]),
        'user-1', { dryRun: true },
      );

      expect(h.assayerLookups).toHaveLength(1);
      expect(h.assayerLookups[0].codes).toEqual(['AS0643', 'AS0361', 'AD0117']);
      expect(summary.updated).toBe(2);
      expect(summary.created).toBe(1);
      expect(summary.issues).toBe(0);
    });

    /**
     * The prefetch must not filter on `isActive`.
     *
     * Deactivating somebody and re-importing the roster has to update the record that names them.
     * A filter would hide it, the importer would try to insert a second record under the same
     * code, and the unique index would refuse it — so one deactivated appraiser would take down
     * the import of everyone after them. This is the branch importer's decision too, where the
     * same filter really did produce twins.
     */
    it('updates a deactivated appraiser rather than inserting a twin', async () => {
      const h = harness({ existing: [{ id: 'a-1', assayerCode: 'AS0643', isActive: false }] });

      const summary = await h.service.importAssayerSheet(
        book([person('Shinil T', 'AS0643')]), 'user-1', { dryRun: true },
      );

      // The appraiser code is the only condition on the lookup — nothing about `isActive`.
      expect(h.assayerLookups[0].conditions).toEqual(['assayer.assayerCode IN (:...codes)']);
      expect(summary.updated).toBe(1);
      expect(summary.created).toBe(0);
      // No insert was attempted, so no savepoint was taken.
      expect(h.queries).toEqual([]);
    });

    /** A code the file names twice is one person updated twice, not a second insert. */
    it('applies a repeated code to the same person instead of inserting them again', async () => {
      const h = harness();

      const summary = await h.service.importAssayerSheet(
        book([person('Shinil T', 'AS0643'), person('Shinil Thomas', 'AS0643')]), 'user-1', { dryRun: true },
      );

      expect(summary.created).toBe(1);
      expect(summary.updated).toBe(1);
      expect(h.queries.filter((q) => q === 'SAVEPOINT roster_row')).toHaveLength(1);
      expect(h.savedAssayers.map((a) => a.assayerCode)).toEqual(['AS0643', 'AS0643']);
    });

    /**
     * The read and the insert are not one act: a second import of the same workbook reads the
     * same gap and both aim at it. Before this, the loser's unique violation threw out of the row
     * loop and rolled back everyone who had already landed.
     */
    it('reports the row that lost a race for its code, and imports the rest', async () => {
      const h = harness({
        onSave: (entity, obj) => {
          if (entity?.name === 'AssayerEntity' && obj.assayerCode === 'AS0361' && obj.id == null) {
            throw uniqueViolation();
          }
        },
      });

      const summary = await h.service.importAssayerSheet(
        book([person('Shinil T', 'AS0643'), person('R Jeganathan', 'AS0361')]), 'user-1', { dryRun: true },
      );

      expect(summary.rowsRead).toBe(2);
      expect(summary.created).toBe(1);
      expect(summary.skipped).toBe(1);
      // The transaction was made usable again, which is what lets the loop carry on at all.
      expect(h.queries).toContain('ROLLBACK TO SAVEPOINT roster_row');

      const reported = h.savedIssues.find((i) => i.sourceAssayerCode === 'AS0361');
      expect(reported).toBeDefined();
      expect(reported.sourceColumn).toBe('Appraiser code');
      expect(reported.rawValue).toBe('AS0361');
      expect(reported.reason).toMatch(/Another import created this appraiser code/);
      expect(reported.reason).toMatch(/Run the import again/);
    });

    /** Only a unique violation is a lost race. Anything else is a real failure and must surface. */
    it('still fails the import when the insert fails for any other reason', async () => {
      const h = harness({
        onSave: (entity: any) => { if (entity?.name === 'AssayerEntity') throw new Error('disk is on fire'); },
      });

      await expect(
        h.service.importAssayerSheet(book([person('Shinil T', 'AS0643')]), 'user-1', { dryRun: true }),
      ).rejects.toThrow('disk is on fire');
    });
  });

  /**
   * Two codes, one identity — the finding that needs a person, and therefore needs to still be
   * there when that person next looks.
   *
   * The real file has exactly this: an AS-series and an AD-series code sharing PAN, phone and
   * email. It used to be reported only in the summary's `notes`, which for a queued import live
   * in the background job's return value — rendered once, into a banner, on a page the operator
   * is told they may leave. These prove the finding also lands in `assayer_import_issues`, the
   * queue the Import issues panel reads and can close with a stated decision.
   */
  describe('the person behind the code — reported, never merged', () => {
    const SHARED_PAN = 'ABCDE1234F';

    const twoRowsSharingAPan = () =>
      book([person('Shinil T', 'AS0643', SHARED_PAN), person('Shinil Thomas', 'AD0117', SHARED_PAN)]);

    it('imports both people — a suspected duplicate is never skipped or merged', async () => {
      const h = harness();

      const summary = await h.service.importAssayerSheet(twoRowsSharingAPan(), 'user-1', { dryRun: true });

      expect(summary.created).toBe(2);
      expect(summary.skipped).toBe(0);
      const saved = h.savedAssayers.filter((a) => a.assayerCode);
      expect(saved.map((a) => a.assayerCode).sort()).toEqual(['AD0117', 'AS0643']);
      // Two records, two ids: nothing was folded into anything.
      expect(new Set(saved.map((a) => a.id)).size).toBe(2);
    });

    it('files the collision in the review queue, naming both codes and the field', async () => {
      const h = harness();

      await h.service.importAssayerSheet(twoRowsSharingAPan(), 'user-1', { dryRun: true });

      const filed = h.savedIssues.find((i) => i.sourceColumn === 'Duplicate PAN');
      expect(filed).toBeDefined();
      // Which two records to compare is the fact a person needs — and it is the two codes, not
      // the shared PAN, that this queue puts on screen.
      expect(filed.rawValue).toBe('AD0117 and AS0643');
      expect(filed.rawValue).not.toContain(SHARED_PAN);
      expect(filed.reason).toContain('AS0643');
      expect(filed.reason).toContain('AD0117');
      expect(filed.reason).toMatch(/registered under two codes/);
      expect(filed.reason).toMatch(/Nothing was merged/);
      // Hung off the second person, so the panel offers a link straight to a record to compare.
      expect(filed.sourceAssayerCode).toBe('AD0117');
      expect(filed.assayerId).toBeTruthy();
    });

    it('also says so in the run summary, so the rehearsal can be called off before it writes', async () => {
      const h = harness();

      const summary = await h.service.importAssayerSheet(twoRowsSharingAPan(), 'user-1', { dryRun: true });

      const note = summary.notes.find((n) => n.includes('AS0643'));
      expect(note).toBeDefined();
      expect(note).toContain('AD0117');
      expect(note).toContain('PAN');
      expect(note).toMatch(/nothing was merged automatically/i);
    });

    /**
     * A collision and an unreadable cell can be about the same column on the same row — an email
     * holding two addresses whose first one is also somebody else's. `saveIssues` dedupes on
     * (sheet, row, column), so the two must not share a key or one silently replaces the other.
     */
    it('keeps a collision and an unreadable cell on the same column apart', async () => {
      const h = harness();

      await h.service.importAssayerSheet(
        book([
          person('Shinil T', 'AS0643', SHARED_PAN),
          // A PAN the shape check refuses, so this row files a "PAN Number" issue of its own.
          person('R Jeganathan', 'AS0361', 'Inactive'),
          person('Shinil Thomas', 'AD0117', SHARED_PAN),
        ]),
        'user-1', { dryRun: true },
      );

      const columns = h.savedIssues.map((i) => i.sourceColumn);
      expect(columns).toContain('PAN Number');
      expect(columns).toContain('Duplicate PAN');
    });
  });
});

/**
 * Reading the workbook without importing it.
 *
 * The controller needs two things before it queues a real import: how many rows there are, for the
 * "this is running in the background" message, and a synchronous refusal of a file that is not a
 * roster. It got both by running a full `dryRun` — which is not a parse. A rehearsal performs the
 * entire import inside a transaction and rolls it back, roughly ten writes per row, so the real
 * 1,155-person roster meant some eleven thousand sequential statements on the request thread,
 * holding a pool connection and taking row locks on `assayers`, before the queued worker did all
 * of it again for real.
 */
describe('RosterImportService.inspectSheet — parse only', () => {
  const service = () => new RosterImportService(
    { run: jest.fn(async () => { throw new Error('inspectSheet must not open a transaction'); }) } as any,
    { enqueueBackfill: jest.fn() } as any,
    { get: jest.fn(async () => { throw new Error('inspectSheet must not read settings'); }) } as any,
  );

  const book = (sheets: Array<[string, any[][]]>): Buffer => {
    const wb = xlsx.utils.book_new();
    for (const [name, aoa] of sheets) xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(aoa), name);
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };

  const BRANCH_SHEET: [string, any[][]] = ['Branch', [
    ['BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets'],
    ['BR-1', 'THENKURISSI', 'PALAKKAD', 'Kerala', 'Main Road', 120],
  ]];

  const ROSTER: [string, any[][]] = ['Assayer ', [
    ['Appraiser Name', 'Appraiser code', 'Residence Address', 'District', 'State'],
    ['Shinil T', 'AS0643', 'Main Road', 'Calicut', 'Kerala'],
    ['R Jeganathan', 'AS0361', 'Anna Nagar', 'Chennai', 'Tamil Nadu'],
  ]];

  it('counts the rows and names the sheet, touching neither the database nor the settings', () => {
    // The mocks throw if either is used — the assertion is that this returns at all.
    const found = service().inspectSheet(book([BRANCH_SHEET, ROSTER]));

    expect(found).toEqual({
      sheetName: 'Assayer ',
      rowsRead: 2,
      headers: ['Appraiser Name', 'Appraiser code', 'Residence Address', 'District', 'State'],
    });
  });

  it('honours an explicit sheet name, as the import does', () => {
    expect(service().inspectSheet(book([BRANCH_SHEET, ROSTER]), 'Assayer ').rowsRead).toBe(2);
  });

  /**
   * The wrong-file guard has to hold here too, because this is what runs before a real import is
   * queued: a pre-flight that accepted a workbook the import then refused would tell the operator
   * their branch list was on its way.
   */
  it('refuses a branch list with the same 400 the import gives', () => {
    expect(() => service().inspectSheet(book([BRANCH_SHEET]))).toThrow(/not the roster this screen imports/);
  });

  it('refuses a workbook with no appraiser-code column, listing the headers it found', () => {
    let caught: any;
    try {
      service().inspectSheet(book([['Sheet1', [['Colour', 'Size'], ['red', 'L']]]]));
    } catch (e) { caught = e; }

    expect(caught?.getStatus?.()).toBe(400);
    expect(String(caught?.message)).toContain('Colour');
  });
});

/**
 * A bare number in a date cell is not a date.
 *
 * `readDate` fell through to `new Date(s)`, and JavaScript reads a bare number as a **year**:
 * `new Date("5484")` is 1 January 5484. So a roster cell holding a plain number — a fee, an
 * employee number, a code typed into the wrong column — became a confident, valid-looking date in
 * the fifth millennium, and nothing downstream questioned it.
 *
 * Measured on the real 1,155-person file after import: **75 dates of birth** between year 0138 and
 * 9952, **58 joining dates**, and **26 exit dates**, every single one landing on `01-01` — the
 * signature of this exact parse. They were worse than blanks, because `qualification-score.service`
 * reads `joiningDate` for tenure, so "joined in 6333" scored on a negative career length with
 * nothing on screen looking wrong.
 */
describe('RosterImportService — dates that are not dates', () => {
  const mockSettings = () => ({ get: jest.fn().mockResolvedValue(false) });
  const mockGeoPrecision = () => ({ enqueueBackfill: jest.fn().mockResolvedValue(undefined) });
  const mockUow = () => ({
    run: jest.fn(async (fn: any) => fn({
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((_e: any, v: any) => v),
      save: jest.fn(async (_e: any, v: any) => ({ id: 'a-1', ...v })),
      getRepository: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(null), find: jest.fn().mockResolvedValue([]) })),
      createQueryBuilder: jest.fn(() => ({ where: () => ({ getMany: jest.fn().mockResolvedValue([]) }) })),
    })),
  });
  const service = () =>
    new RosterImportService(mockUow() as any, mockGeoPrecision() as any, mockSettings() as any);

  /** `readDate` is private; these exercise it directly, which is where the defect lives. */
  const read = (raw: unknown) => {
    const issues: any[] = [];
    const value = (service() as any).readDate(raw, { issues, sourceRow: 2, sheet: 'Assayers', column: 'Joining Date' });
    return { value, issues };
  };

  /** The same, read as a date of birth — which gets no future allowance at all. */
  const readBirth = (raw: unknown) => {
    const issues: any[] = [];
    const value = (service() as any).readDate(
      raw, { issues, sourceRow: 2, sheet: 'Assayers', column: 'D.O.B' }, 'birth',
    );
    return { value, issues };
  };

  it.each(['4200', '5484', '6299', '3009', '9952'])(
    'refuses %s — a bare number JavaScript would read as a year',
    (raw) => {
      const { value, issues } = read(raw);
      expect(value).toBeNull();
      expect(issues).toHaveLength(1);
      expect(issues[0].rawValue).toBe(raw);
      // The reason has to say what happened, or the operator cannot find the cell on their sheet.
      expect(issues[0].reason).toMatch(/not a real date for a person/);
    },
  );

  it('refuses a year 0138 date of birth as readily as a year 9952 one', () => {
    expect(read('0138').value).toBeNull();
    expect(read('9952').value).toBeNull();
  });

  /**
   * The other half: the bound must not refuse anything real. These are the shapes the actual roster
   * carries, including the quoted-text and trailing-punctuation forms the parser already handled.
   */
  it.each([
    ['11-01-1997', 1997],
    ["'03-01-1974", 1974],
    ['27-04-2026.', 2026],
    ['02-Nov-2022', 2022],
    ['31-10-23', 2023],
  ])('still reads %s', (raw, year) => {
    const { value, issues } = read(raw);
    expect(value).not.toBeNull();
    expect(value!.getFullYear()).toBe(year);
    expect(issues).toHaveLength(0);
  });

  /**
   * A four-digit year on its own IS a legitimate way to write a joining date, and the fix must not
   * throw it away — only implausible ones go.
   */
  it('accepts a plain year that is actually plausible', () => {
    const { value, issues } = read('1997');
    expect(value?.getFullYear()).toBe(1997);
    expect(issues).toHaveLength(0);
  });

  it('accepts a future-dated exit, because a notice period served in advance is real', () => {
    const nextYear = new Date().getFullYear() + 1;
    expect(read(`30-06-${nextYear}`).value?.getFullYear()).toBe(nextYear);
  });

  it('still reports a cell that is not a date at all, rather than silently blanking it', () => {
    const { value, issues } = read('sanjayk');
    expect(value).toBeNull();
    expect(issues[0].reason).toMatch(/Could not be read as a date/);
  });

  /**
   * The bound covers every shape, not only the bare number that prompted it.
   *
   * It was written for `new Date("5484")` and applied at that one call site, so the two shapes
   * matched earlier — `01-01-5484` and `02-Nov-5484` — returned year 5484 unchecked. Nothing
   * caught it because the rule's own comment said the result was bounded, and the corruption in
   * the roster we have happens to arrive as bare numbers. A re-import is allowed to bring a
   * differently-broken sheet, and this is the whole point of a guard: it has to hold for the
   * input nobody predicted, not only the one that was already found.
   */
  it.each([
    ['01-01-5484', 'day-first with an impossible year'],
    ['02-Nov-5484', 'month-as-a-word with an impossible year'],
    ['15/06/9952', 'slash-separated with an impossible year'],
  ])('refuses %s (%s), not only a bare number', (raw) => {
    const { value, issues } = read(raw);
    expect(value).toBeNull();
    expect(issues[0].reason).toMatch(/not a real date for a person/);
  });

  it('bounds a Date handed straight over by the spreadsheet reader too', () => {
    // xlsx hands back a real Date for a date-formatted cell, and that path returned it untouched.
    const { value, issues } = read(new Date(Date.UTC(5484, 0, 1)) as any);
    expect(value).toBeNull();
    expect(issues[0].reason).toMatch(/not a real date for a person/);
  });

  it('still passes an ordinary Date from the spreadsheet reader through', () => {
    const ordinary = new Date(1997, 0, 11);
    const { value, issues } = read(ordinary as any);
    expect(value).toBe(ordinary);
    expect(issues).toHaveLength(0);
  });

  /**
   * How far ahead a date may sit depends on what it is for, and one window for both was wrong at
   * both ends.
   *
   * Employment dates were bounded at two years while the data-integrity scan treats anything
   * within five as plausible — so a fixed-term engagement ending in four years was refused here
   * and would have been waved through there, with the operator told a real date was "not a real
   * date for a person". Birth dates shared that two-year allowance, which is two years of dates
   * nobody can have been born on being accepted without a murmur.
   */
  it('accepts an employment date years ahead, matching what the integrity scan calls plausible', () => {
    const inFourYears = new Date().getFullYear() + 4;
    const { value, issues } = read(`30-06-${inFourYears}`);
    expect(value?.getFullYear()).toBe(inFourYears);
    expect(issues).toHaveLength(0);
  });

  it('refuses an employment date beyond that window', () => {
    const wayOut = new Date().getFullYear() + 9;
    expect(read(`30-06-${wayOut}`).value).toBeNull();
  });

  it('refuses a date of birth in the future, however near', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const { value, issues } = readBirth(tomorrow as any);

    expect(value).toBeNull();
    expect(issues[0].reason).toMatch(/nobody is born on a date that has not happened yet/);
  });

  it('accepts a date of birth of today, and of long ago', () => {
    expect(readBirth(new Date() as any).value).not.toBeNull();
    expect(readBirth('11-01-1997').value?.getFullYear()).toBe(1997);
  });

  it('still refuses an impossible year as a birth date, with the parse-failure wording', () => {
    const { value, issues } = readBirth('9952');
    expect(value).toBeNull();
    expect(issues[0].reason).toMatch(/not a real date for a person/);
  });
});

/**
 * Aadhaar leaves the length-only era.
 *
 * `/^\d{12}$/` accepted any twelve digits, so a mistyped Aadhaar was stored as confidently as a
 * real one and surfaced later as a KYC record matching nobody. The rule now lives in
 * `@fapoms/shared` (same one the API DTOs enforce) and carries the Verhoeff checksum a genuine
 * Aadhaar always satisfies. The importer's posture is unchanged: report, never throw — a bad
 * cell files an issue naming its row while the person is still imported.
 */
describe('roster import — Aadhaar checksum', () => {
  const HEADERS = ['Appraiser Name', 'Appraiser code', 'Aadhar Card Number', 'Residence Address', 'Location', 'District', 'State'];

  const person = (name: string, code: string, aadhaar = '') =>
    [name, code, aadhaar, 'Main Road, Kunnamangalam', 'Kunnamangalam', 'Calicut', 'Kerala'];

  const book = (rows: any[][]): Buffer => {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([HEADERS, ...rows]), 'Assayer');
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };

  const harness = (existing: Array<Record<string, any>> = []) => {
    const savedAssayers: any[] = [];
    const savedIssues: any[] = [];
    let n = 1;
    const manager: any = {
      find: async () => [],
      createQueryBuilder: () => {
        let codes: string[] = [];
        const qb: any = {
          where: (_sql: string, params?: any) => { codes = params?.codes ?? codes; return qb; },
          getMany: async () => existing.filter((a) => codes.includes(a.assayerCode)),
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

  // 999941057058: payload 99994105705 carries Verhoeff check digit 8 (also UIDAI's test range).
  const VALID_AADHAAR = '999941057058';
  // Same digits, last one bumped — the shape check passes, the checksum must not.
  const MISTYPED_AADHAAR = '999941057059';

  it('stores a checksum-valid Aadhaar exactly as before', async () => {
    const h = harness();
    const summary = await h.service.importAssayerSheet(
      book([person('Shinil T', 'AS0643', VALID_AADHAAR)]), 'user-1', { dryRun: true },
    );
    expect(h.savedAssayers[0].aadhaarNumber).toBe(VALID_AADHAAR);
    expect(summary.issues).toBe(0);
  });

  it('sends a twelve-digit number that fails the checksum to review, naming its row, and stores nothing', async () => {
    const h = harness();
    const summary = await h.service.importAssayerSheet(
      book([person('Shinil T', 'AS0643', MISTYPED_AADHAAR)]), 'user-1', { dryRun: true },
    );

    // The person is still imported — a bad cell must not cost the row.
    expect(h.savedAssayers).toHaveLength(1);
    expect(h.savedAssayers[0].aadhaarNumber).toBeNull();

    const issue = h.savedIssues.find((i) => i.sourceColumn === 'Aadhar Card Number');
    expect(issue).toBeDefined();
    expect(issue.sourceRow).toBe(2); // header is row 1; the operator finds the cell by this
    expect(issue.rawValue).toBe(MISTYPED_AADHAAR);
    expect(issue.reason).toMatch(/checksum fails/);
    expect(summary.issues).toBeGreaterThan(0);
  });

  it('keeps an existing stored Aadhaar when a re-import row carries a failing one', async () => {
    const h = harness([{ id: 'a-1', assayerCode: 'AS0643', aadhaarNumber: VALID_AADHAAR }]);
    await h.service.importAssayerSheet(
      book([person('Shinil T', 'AS0643', MISTYPED_AADHAAR)]), 'user-1', { dryRun: true },
    );
    // Same keep-what-we-had rule an unreadable cell gets: review the cell, do not blank the record.
    expect(h.savedAssayers[0].aadhaarNumber).toBe(VALID_AADHAAR);
    expect(h.savedIssues.some((i) => i.sourceColumn === 'Aadhar Card Number')).toBe(true);
  });

  it('still refuses the words the column is known to hold, with the shape message', async () => {
    const h = harness();
    await h.service.importAssayerSheet(
      book([person('R Jeganathan', 'AS0361', 'Inactive')]), 'user-1', { dryRun: true },
    );
    const issue = h.savedIssues.find((i) => i.sourceColumn === 'Aadhar Card Number');
    expect(issue.reason).toMatch(/expected 12 digits/);
    expect(h.savedAssayers[0].aadhaarNumber).toBeNull();
  });

  /**
   * The placeholder message. `999999999999` PASSES Verhoeff — `isValidAadhaar` refuses it on the
   * all-same-digit rule, before the checksum runs — so reporting it as a checksum failure told
   * the clerk to re-read a card looking for a mistyped digit in a number that has none. That is
   * a wasted trip to a filing cabinet for the single likeliest junk value in this column.
   */
  const PLACEHOLDER_AADHAAR = '999999999999';

  it('names a twelve-identical-digit cell a placeholder, not a checksum failure', async () => {
    const h = harness();
    await h.service.importAssayerSheet(
      book([person('Shinil T', 'AS0643', PLACEHOLDER_AADHAAR)]), 'user-1', { dryRun: true },
    );

    const issue = h.savedIssues.find((i) => i.sourceColumn === 'Aadhar Card Number');
    expect(issue).toBeDefined();
    expect(issue.rawValue).toBe(PLACEHOLDER_AADHAAR);
    expect(issue.reason).toMatch(/placeholder/i);
    // The wrong advice must be absent, not merely outweighed: nothing here is mistyped.
    expect(issue.reason).not.toMatch(/checksum/i);
    expect(issue.reason).not.toMatch(/mistyped or swapped/i);
    // Same posture as any other bad cell: the person is imported, the number is not stored.
    expect(h.savedAssayers).toHaveLength(1);
    expect(h.savedAssayers[0].aadhaarNumber).toBeNull();
  });

  it('keeps the checksum message for a genuine typo, so the two stay told apart', async () => {
    const h = harness();
    await h.service.importAssayerSheet(
      book([person('Shinil T', 'AS0643', MISTYPED_AADHAAR)]), 'user-1', { dryRun: true },
    );
    const issue = h.savedIssues.find((i) => i.sourceColumn === 'Aadhar Card Number');
    expect(issue.reason).toMatch(/checksum fails/);
    expect(issue.reason).not.toMatch(/placeholder/i);
  });

  it('reports every all-same-digit value as a placeholder, not just the nines', async () => {
    for (let d = 0; d <= 9; d++) {
      const h = harness();
      await h.service.importAssayerSheet(
        book([person('Shinil T', 'AS0643', String(d).repeat(12))]), 'user-1', { dryRun: true },
      );
      const issue = h.savedIssues.find((i) => i.sourceColumn === 'Aadhar Card Number');
      expect(issue.reason).toMatch(/placeholder/i);
    }
  });
});

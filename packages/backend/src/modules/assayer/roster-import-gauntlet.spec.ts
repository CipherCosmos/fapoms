import * as xlsx from 'xlsx';
import { RosterImportService } from './roster-import.service';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';

/**
 * The re-upload gauntlet: one workbook carrying every defect class the REAL roster taught us.
 *
 * The owner's contract for this pipeline, in their words: the old sheet will be wiped and
 * re-uploaded, and it "should pass with our pipeline in the correct way and should get resolved
 * all the error automatically" — with no false positives or negatives. Concretely that means:
 * everything derivable is derived (region from state, status from lifecycle), everything corrupt
 * is refused AND reported with the exact cell (never stored, never silently dropped), and
 * everything ambiguous becomes a named review item rather than a guess.
 *
 * Each test below is one class of damage the 2026-09-02 import actually did, so this file is the
 * regression net for the next upload of the same file. The classes:
 *
 *   1. the roster hiding on the second sheet, named `Assayer ` with a trailing space
 *      (the importer demanded a sheet called exactly "Assayers" and threw a 500);
 *   2. bare numbers in date cells — `new Date("4200")` is 1 Jan 4200 — which stored 159
 *      fifth-millennium dates across 147 people and fed negative tenure into scoring;
 *   3. words in date cells ("sanjayk" really sits in a DOB cell in the source file);
 *   4. the same person registered under two appraiser codes (the file really carries an
 *      AS-series and AD-series code sharing a PAN) — imported, never merged, loudly reported;
 *   5. a row with no state at all — the person must land (they exist) but with `region` null,
 *      which the data-integrity scanner then surfaces; the importer must not invent geography.
 */
describe('roster re-upload gauntlet — the old sheet passes correctly', () => {
  const mockSettings = () => ({ get: jest.fn().mockResolvedValue(false) });
  const mockGeoPrecision = () => ({ enqueueBackfill: jest.fn().mockResolvedValue(undefined) });

  /**
   * Captures every entity the import tries to persist, so assertions can read them back.
   *
   * `saved` holds what COMMITTED and `attempted` holds every write the import performed, because
   * the two differ for a rehearsal and the difference is the whole of the dry-run contract. The
   * fake unit of work therefore has to behave like a transaction rather than a passthrough: it
   * buffers each save and only appends the buffer to `saved` once the callback resolves. A
   * callback that throws — which is exactly how `dryRun` ends, via the private `DryRunComplete`
   * the service raises to unwind the transaction — leaves `saved` empty, the way a real ROLLBACK
   * would. A passthrough `run: (fn) => fn(manager)` cannot express that, so a test written
   * against one can only ever assert that the rehearsal DID write, which is the opposite of the
   * guarantee.
   */
  const harness = () => {
    const saved: Array<{ entity: string; value: any }> = [];
    const attempted: Array<{ entity: string; value: any }> = [];
    let open: Array<{ entity: string; value: any }> | null = null;
    const manager = {
      // The duplicate-code race guard wraps each insert in SAVEPOINT/RELEASE via raw query.
      query: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((_e: any, v: any) => v),
      save: jest.fn(async (e: any, v: any) => {
        const push = (one: any) => {
          if (one && !one.id) one.id = `id-${attempted.length + 1}`;
          const row = { entity: e?.name ?? String(e), value: one };
          attempted.push(row);
          (open ?? saved).push(row);
        };
        (Array.isArray(v) ? v : [v]).forEach(push);
        return v;
      }),
      getRepository: jest.fn(() => ({
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockResolvedValue([]),
      })),
      createQueryBuilder: jest.fn(() => ({
        where: () => ({ getMany: jest.fn().mockResolvedValue([]) }),
      })),
    };
    const uow = {
      run: jest.fn(async (fn: any) => {
        const pending: Array<{ entity: string; value: any }> = [];
        open = pending;
        try {
          const out = await fn(manager);
          // Skipped when the callback throws, which leaves `pending` discarded — the rollback.
          saved.push(...pending);
          return out;
        } finally {
          open = null;
        }
      }),
    };
    const geo = mockGeoPrecision();
    const service = new RosterImportService(uow as any, geo as any, mockSettings() as any);
    return { service, saved, attempted, geo, manager };
  };

  const book = (rows: any[][]): Buffer => {
    const wb = xlsx.utils.book_new();
    // The real file's shape: branch list first, roster second, trailing space in the name.
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([
      ['BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets'],
      ['BR-1', 'THENKURISSI', 'PALAKKAD', 'Kerala', 'Main Road', 120],
    ]), 'Branch');
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'Assayer ');
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };

  const HEAD = ['Appraiser Name', 'Appraiser code', 'Residence Address', 'District', 'State',
    'Joining Date', 'Date of Birth', 'PAN Number'];

  const issuesOf = (saved: Array<{ entity: string; value: any }>) =>
    saved.filter((s) => s.entity === AssayerImportIssueEntity.name).map((s) => s.value);
  const peopleOf = (saved: Array<{ entity: string; value: any }>) =>
    saved.filter((s) => s.entity === 'AssayerEntity').map((s) => s.value);

  it('finds the roster on the second, trailing-space sheet and imports every person', async () => {
    const { service, saved } = harness();

    const summary = await service.importAssayerSheet(book([
      HEAD,
      ['Shinil T', 'GAUNT-1', 'Kunnamangalam', 'Calicut', 'Kerala', '11-01-2021', '11-01-1997', ''],
      ['R Jeganathan', 'GAUNT-2', 'Anna Nagar', 'Chennai', 'Tamil Nadu', '02-Nov-2022', '', ''],
    ]), 'user-1', { dryRun: false });

    expect(summary.rowsRead).toBe(2);
    expect(summary.created).toBe(2);
    expect(summary.skipped).toBe(0);
    // Region derived from the state, so nobody is invisible to a territorial desk.
    const people = peopleOf(saved);
    expect(people.find((p) => p.assayerCode === 'GAUNT-1')?.region).toBe('SOUTH');
    expect(people.find((p) => p.assayerCode === 'GAUNT-2')?.region).toBe('SOUTH');
  });

  it('refuses a bare-number date, keeps the person, and names the exact cell', async () => {
    const { service, saved } = harness();

    const summary = await service.importAssayerSheet(book([
      HEAD,
      ['Perf Person', 'GAUNT-3', 'Somewhere', 'Calicut', 'Kerala', '4200', '5484', ''],
    ]), 'user-1', { dryRun: false });

    // The person exists — a broken date cell must not cost the whole row.
    expect(summary.created).toBe(1);
    const person = peopleOf(saved).find((p) => p.assayerCode === 'GAUNT-3');
    expect(person?.joiningDate ?? null).toBeNull();
    expect(person?.dateOfBirth ?? null).toBeNull();

    // And both cells are on the review queue with their verbatim values — recoverable, not lost.
    const issues = issuesOf(saved);
    const joining = issues.find((i) => i.sourceColumn === 'Joining Date');
    const dob = issues.find((i) => i.sourceColumn === 'D.O.B');
    expect(joining?.rawValue).toBe('4200');
    expect(joining?.reason).toMatch(/not a real date for a person/);
    expect(dob?.rawValue).toBe('5484');
  });

  it('reports a word sitting in a date cell instead of silently blanking it', async () => {
    const { service, saved } = harness();

    await service.importAssayerSheet(book([
      HEAD,
      ['Sanjay K', 'GAUNT-4', 'Somewhere', 'Pune', 'Maharashtra', '', 'sanjayk', ''],
    ]), 'user-1', { dryRun: false });

    const issue = issuesOf(saved).find((i) => i.sourceColumn === 'D.O.B');
    expect(issue?.rawValue).toBe('sanjayk');
    expect(issue?.reason).toMatch(/Could not be read as a date/);
  });

  it('imports both people who share a PAN under two codes, and reports the pair by CODE, never the PAN', async () => {
    const { service, saved } = harness();

    const summary = await service.importAssayerSheet(book([
      HEAD,
      ['Same Person', 'GAUNT-5', 'Somewhere', 'Calicut', 'Kerala', '', '', 'ABCDE1234F'],
      ['Same Person Again', 'GAUNT-6', 'Somewhere', 'Calicut', 'Kerala', '', '', 'ABCDE1234F'],
    ]), 'user-1', { dryRun: false });

    // Never auto-merged: two brothers can share a phone; a wrong merge destroys a real person's
    // history. Both exist, and a human decides.
    expect(summary.created).toBe(2);

    const dup = issuesOf(saved).find((i) => i.sourceColumn === 'Duplicate PAN');
    expect(dup).toBeDefined();
    expect(dup.rawValue).toBe(['GAUNT-5', 'GAUNT-6'].sort().join(' and '));
    // The leak guard: this queue is rendered on screen, so the shared identifier itself must
    // never appear in the finding.
    expect(JSON.stringify(dup)).not.toContain('ABCDE1234F');
  });

  it('lands a person with no state at all, with region left honestly null for the scanner', async () => {
    const { service, saved } = harness();

    const summary = await service.importAssayerSheet(book([
      HEAD,
      ['No State Person', 'GAUNT-7', 'Somewhere', '', '', '', '', ''],
    ]), 'user-1', { dryRun: false });

    expect(summary.created).toBe(1);
    const person = peopleOf(saved).find((p) => p.assayerCode === 'GAUNT-7');
    // Not invented. A null region is a visible data gap the integrity scanner raises; a guessed
    // one is a person silently filed under the wrong desk.
    expect(person?.region ?? null).toBeNull();
  });

  it('hands every imported person to the geocoding backfill, so pins fill in automatically', async () => {
    const { service, geo } = harness();

    await service.importAssayerSheet(book([
      HEAD,
      ['Shinil T', 'GAUNT-8', 'Kunnamangalam', 'Calicut', 'Kerala', '', '', ''],
    ]), 'user-1', { dryRun: false });

    expect(geo.enqueueBackfill).toHaveBeenCalledWith(
      'assayer',
      expect.arrayContaining([expect.any(String)]),
      expect.stringContaining('roster import'),
    );
  });

  /**
   * The rehearsal's contract has two halves, and only asserting both of them says anything.
   *
   * It must WRITE — the importer's own docblock records that an earlier version counted instead
   * of writing and reported a clean 1,155-row rehearsal for an import that then failed on its
   * first insert, a rehearsal of the reader rather than of the import. And it must LAND NOTHING,
   * because the operator is being shown a consequence-free preview.
   *
   * Assert only the second and a version that skips the writes passes; assert only the first and
   * a version that forgets to roll back passes. So this pins the pair: the writes happened, and
   * the transaction discarded them.
   *
   * This test previously read `peopleOf(saved).length + issuesOf(saved).length >= 0` — the sum of
   * two array lengths, which is true of every possible run — and excused itself with a note that
   * the rollback was asserted in `roster-import.spec.ts`. It was not, there or anywhere: both
   * roster specs stubbed the unit of work as a passthrough that could not roll anything back, so
   * nothing in the suite had ever observed this guarantee.
   */
  it('a rehearsal of the same broken sheet writes, then lands nothing at all', async () => {
    const { service, saved, attempted, geo } = harness();

    const summary = await service.importAssayerSheet(book([
      HEAD,
      ['Perf Person', 'GAUNT-9', 'Somewhere', 'Calicut', 'Kerala', '4200', '', ''],
    ]), 'user-1', { dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.created).toBe(1); // reported as WOULD-create…
    // …the person and the bad-date issue were really written inside the transaction…
    expect(attempted.filter((s) => s.entity === 'AssayerEntity')).toHaveLength(1);
    expect(attempted.filter((s) => s.entity === AssayerImportIssueEntity.name).length)
      .toBeGreaterThanOrEqual(1);
    // …and not one of them survived it.
    expect(peopleOf(saved)).toEqual([]);
    expect(issuesOf(saved)).toEqual([]);
    // Nor is anything handed downstream off rows that no longer exist: the geocoding backfill
    // would otherwise be queued ids the rollback has just taken away.
    expect(geo.enqueueBackfill).not.toHaveBeenCalled();
    // The operator still sees the broken cell BEFORE importing — that is the point of rehearsing.
    expect(summary.issues).toBeGreaterThanOrEqual(1);
  });

  /**
   * The silent-loss class: a heading the importer does not recognise.
   *
   * Proved on the live stack before this guard existed — a sheet headed `Aadhaar Number` (the
   * importer reads `Aadhar Card Number`) imported all six rows, reported "created 6, skipped 0",
   * and discarded every Aadhaar number without a word. On the real 1,155-person roster that is 578
   * government IDs gone with nothing on screen to suggest it. The column is NAMED, never
   * fuzzy-matched into a field: guessing is how the wrong column lands in the right-looking place.
   */
  describe('a column the importer does not recognise', () => {
    it('names the column and how many rows carried data, instead of dropping it silently', async () => {
      const { service } = harness();

      const summary = await service.importAssayerSheet(book([
        [...HEAD, 'Aadhaar Number'],
        ['Header Drift', 'GAUNT-10', 'Somewhere', 'Calicut', 'Kerala', '', '', '', '515407479363'],
      ]), 'user-1', { dryRun: false });

      const note = (summary.notes ?? []).find((n: string) => n.includes('Aadhaar Number'));
      expect(note).toBeDefined();
      expect(note).toMatch(/not recognised/);
      expect(note).toMatch(/1 row\(s\)/);
      // The person still imports — a stray column must not cost the whole row.
      expect(summary.created).toBe(1);
    });

    /**
     * The blind spot an independent audit found in this very guard.
     *
     * `sheet_to_json` drops a column from a row object when that row's cell is blank, so headers
     * taken from `rows[0]` describe row 1, not the sheet. Only 578 of the real roster's 1,155 rows
     * carry an Aadhaar — so a mis-headed `Aadhaar Number` column had roughly even odds of being
     * invisible to the report built to catch exactly that heading. Headers are now the union
     * across all rows.
     */
    it('still names an unrecognised column whose FIRST row happens to be blank', async () => {
      const { service } = harness();

      const summary = await service.importAssayerSheet(book([
        [...HEAD, 'Aadhaar Number'],
        ['Blank First', 'GAUNT-13', 'Somewhere', 'Calicut', 'Kerala', '', '', '', ''],
        ['Has Value', 'GAUNT-14', 'Somewhere', 'Calicut', 'Kerala', '', '', '', '515407479363'],
      ]), 'user-1', { dryRun: false });

      const note = (summary.notes ?? []).find((n: string) => n.includes('Aadhaar Number'));
      expect(note).toBeDefined();
      expect(note).toMatch(/1 row\(s\)/);
    });

    it('says nothing about a column it does read', async () => {
      const { service } = harness();

      const summary = await service.importAssayerSheet(book([
        [...HEAD, 'Aadhar Card Number'],
        ['Header OK', 'GAUNT-11', 'Somewhere', 'Calicut', 'Kerala', '', '', '', '515407479363'],
      ]), 'user-1', { dryRun: false });

      expect((summary.notes ?? []).some((n: string) => n.includes('not recognised'))).toBe(false);
    });

    /**
     * The report must not invent a loss either.
     *
     * A heading is registered as recognised by the act of READING it, and two readers sat below an
     * early return: `CIBIL date` is only reached once a row carries some background-check value,
     * and `ICICI Documents required` only once a row carries an ICICI standing. So a sheet that
     * has those columns but no rows filling their partners never asked for them, and the report
     * named them as columns nobody read whose data was not imported — about data that had nothing
     * to attach itself to. A guard against silent loss is worth nothing if it cries wolf; both
     * readers are now above their early return.
     */
    it('does not claim a column was dropped when the rows simply had nothing in its partner', async () => {
      const { service } = harness();

      const summary = await service.importAssayerSheet(book([
        [...HEAD, 'CIBIL  date', 'ICICI Documents required'],
        // No 'Background Verification Done', 'CIBIL Status', 'Cibil Score' or 'ICICI Status'
        // column at all, so both owners return early on every row.
        ['No Vetting', 'GAUNT-15', 'Somewhere', 'Calicut', 'Kerala', '', '', '', '02-Nov-2022', 'PAN copy'],
      ]), 'user-1', { dryRun: false });

      const notes = summary.notes ?? [];
      expect(notes.some((n: string) => n.includes('CIBIL') && n.includes('not recognised'))).toBe(false);
      expect(notes.some((n: string) => n.includes('ICICI') && n.includes('not recognised'))).toBe(false);
      expect(summary.created).toBe(1);
    });

    /** A trailing empty column is ordinary spreadsheet debris; naming it would bury the real one. */
    it('says nothing about an unrecognised column that is entirely blank', async () => {
      const { service } = harness();

      const summary = await service.importAssayerSheet(book([
        [...HEAD, 'Some Empty Column'],
        ['Blank Col', 'GAUNT-12', 'Somewhere', 'Calicut', 'Kerala', '', '', '', ''],
      ]), 'user-1', { dryRun: false });

      expect((summary.notes ?? []).some((n: string) => n.includes('Some Empty Column'))).toBe(false);
    });
  });
});

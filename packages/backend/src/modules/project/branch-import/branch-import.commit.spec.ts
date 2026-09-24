import type { BranchImportDecisions, BranchReviewReport } from '@fapoms/shared';
import { commitBranchImport } from './branch-import.commit';
import { rehearseBranchImport } from './branch-import.rehearsal';
import { countingLookups, master, MemoryBranchStore, parsed, quietHooks, target } from './branch-import.fixtures';
import type { BranchImportTarget } from './branch-import.types';

const row = (overrides: Record<string, unknown> = {}) => ({
  BRANCH: 'S-1',
  BRANCH_NAME: 'Thenkurissi',
  DISTRICT: 'Palakkad',
  STATE: 'Kerala',
  'Branch Address': '1 Main Road, Thenkurissi 678671',
  Packets: 58,
  ...overrides,
});

const allValid: BranchImportDecisions = { mode: 'all_valid', excluded: [], edits: {} };

async function review(store: MemoryBranchStore, rows: Array<Record<string, unknown>>, t: BranchImportTarget = target()): Promise<BranchReviewReport> {
  const { lookups } = countingLookups();
  return (await rehearseBranchImport(parsed(rows), t, store.reads(), lookups, quietHooks())).report;
}

async function commit(
  store: MemoryBranchStore,
  report: BranchReviewReport,
  decisions: BranchImportDecisions = allValid,
  opts: { target?: BranchImportTarget; regions?: string[] | null; shouldStop?: () => Promise<boolean> } = {},
) {
  const { lookups, calls } = countingLookups();
  const outcome = await commitBranchImport(
    { report, decisions, target: opts.target ?? target(), userId: 'u-1', jobId: 'job-1', regions: opts.regions ?? null },
    store.commitStore(),
    lookups,
    quietHooks(opts.shouldStop ? { shouldStop: opts.shouldStop } : {}),
  );
  return { outcome, calls };
}

describe('branch import commit', () => {
  it('creates new branches and corrects known ones — only the fields that changed', async () => {
    const store = new MemoryBranchStore([master({ solId: 'S-2', name: 'Old name' }), master({ solId: 'S-3', name: 'Ottapalam', estimatedDurationHours: 14.5 })]);
    const report = await review(store, [
      row(),
      row({ BRANCH: 'S-2', BRANCH_NAME: 'New name', 'Branch Address': '' }),
      row({ BRANCH: 'S-3', BRANCH_NAME: 'Ottapalam', 'Branch Address': '', DISTRICT: '' }),
    ]);
    const { outcome } = await commit(store, report);

    expect(outcome.counts).toMatchObject({ created: 1, updated: 1, unchanged: 1, skipped: 0 });
    const created = store.bySol('S-1')!;
    expect(created).toMatchObject({ name: 'Thenkurissi', region: 'SOUTH', district: 'PALAKKAD', estimatedDurationHours: 14.5, complexity: 'STANDARD' });
    expect(store.bySol('S-2')!.name).toBe('New name');
    // A sparse sheet does not blank what it did not mention.
    expect(store.bySol('S-2')!.address).toBe('1 Main Road, Palakkad 678001');
  });

  it('works out audit hours from the client\'s own minutes per packet, not a fixed 15', async () => {
    const store = new MemoryBranchStore();
    const report = await review(store, [row({ Packets: 60 })]);
    await commit(store, report, allValid, { target: target({ minutesPerPacket: 10 }) });
    expect(store.bySol('S-1')!.estimatedDurationHours).toBe(10);
  });

  it('restores an archived branch the file still lists, instead of creating a twin', async () => {
    const store = new MemoryBranchStore([master({ solId: 'S-1', isActive: false })]);
    const report = await review(store, [row()]);
    const { outcome } = await commit(store, report);
    expect(outcome.counts).toMatchObject({ created: 0, revived: 1 });
    expect(outcome.revived[0].reason).toMatch(/was archived and has been restored/);
    expect(store.branches.size).toBe(1);
    expect(store.bySol('S-1')!.isActive).toBe(true);
  });

  describe('applies the review\'s decisions to the rows the server stored', () => {
    it('leaves out removed rows, rows still missing details and rows of another bank', async () => {
      const store = new MemoryBranchStore();
      const report = await review(store, [
        row(),
        row({ BRANCH: 'S-2' }),
        row({ BRANCH: 'S-3', STATE: '', BANK: '' }),
        row({ BRANCH: 'S-4', BANK: 'HDFC Bank' }),
      ], target({ clientName: 'Some Cooperative', bankCode: null }));
      // Re-flag S-4 as the rehearsal would for SBI.
      report.rows[3].clientMismatch = { expectedBank: 'SBI', reason: 'Another bank', severity: 'critical' };
      const { outcome } = await commit(store, report, { mode: 'all_valid', excluded: [report.rows[1].rowNumber], edits: {} });

      expect([...store.branches.values()].map((b) => b.solId)).toEqual(['S-1']);
      expect(outcome.removed).toHaveLength(1);
      expect(outcome.skipped.map((s) => s.solId).sort()).toEqual(['S-3', 'S-4']);
    });

    it('takes typed-over fields and a hand-placed pin — and nothing else a request carries', async () => {
      const store = new MemoryBranchStore();
      const report = await review(store, [row({ STATE: '' }), row({ BRANCH: 'S-2' })], target({ clientName: 'X', bankCode: null }));
      const [first, second] = report.rows;
      const { outcome } = await commit(store, report, {
        mode: 'all_valid',
        excluded: [],
        edits: {
          [first.rowNumber]: { state: 'Kerala' },
          // A browser naming its own geo source, accuracy or region is ignored; a pin is a manual pin.
          [second.rowNumber]: { latitude: 10.9, longitude: 76.9, geoSource: 'google', geoAccuracyMeters: 1, region: 'NORTH' } as any,
        },
      });

      expect(outcome.counts.created).toBe(2);
      expect(store.bySol('S-1')!.state).toBe('Kerala');
      expect(store.bySol('S-2')).toMatchObject({ latitude: 10.9, longitude: 76.9, geoSource: 'manual', geoAccuracyMeters: 5, region: 'SOUTH' });
    });

    it('refuses a pin outside India, and a typed pincode that is not one, for that row alone', async () => {
      const store = new MemoryBranchStore();
      const report = await review(store, [row(), row({ BRANCH: 'S-2' }), row({ BRANCH: 'S-3' })]);
      const [a, b] = report.rows;
      const { outcome } = await commit(store, report, {
        mode: 'all_valid',
        excluded: [],
        edits: { [a.rowNumber]: { latitude: 51.5, longitude: -0.1 }, [b.rowNumber]: { pincode: '12' } },
      });
      expect(outcome.counts.created).toBe(1);
      expect(outcome.skipped.map((s) => s.reason)).toEqual([
        expect.stringMatching(/not a location in India/),
        expect.stringMatching(/"12" is not a valid pincode/),
      ]);
    });

    it('commits only exactly located rows when asked to', async () => {
      const store = new MemoryBranchStore();
      const report = await review(store, [row(), row({ BRANCH: 'S-2', 'Google Maps Link': '10.7,76.6' })]);
      const { outcome } = await commit(store, report, { mode: 'ready_only', excluded: [], edits: {} });
      expect([...store.branches.values()].map((b) => b.solId)).toEqual(['S-2']);
      expect(outcome.skipped[0].reason).toMatch(/only exactly located/);
    });

    it('names a SOL ID typed into two rows, keeping the first', async () => {
      const store = new MemoryBranchStore();
      const report = await review(store, [row(), row({ BRANCH: 'S-2' })]);
      const { outcome } = await commit(store, report, { mode: 'all_valid', excluded: [], edits: { [report.rows[1].rowNumber]: { solId: 'S-1' } } });
      expect(outcome.counts.created).toBe(1);
      expect(outcome.skipped[0].reason).toMatch(/Duplicate of row/);
    });

    it('places a row again when an edit moves it', async () => {
      const store = new MemoryBranchStore();
      const report = await review(store, [row()]);
      const { calls } = await commit(store, report, { mode: 'all_valid', excluded: [], edits: { [report.rows[0].rowNumber]: { address: 'Fort Road, Palakkad 678013' } } });
      expect(calls.geocode).toHaveLength(1);
      expect(calls.geocode[0].pincode).toBe('678013');
    });
  });

  it('writes 200 rows to a transaction, and tells open screens once per chunk', async () => {
    const store = new MemoryBranchStore();
    const rows = Array.from({ length: 450 }, (_, i) => row({ BRANCH: `B-${i}` }));
    const report = await review(store, rows);
    const { outcome } = await commit(store, report);
    expect(store.chunks).toEqual([200, 200, 50]);
    expect(store.announced).toEqual([200, 200, 50]);
    expect(outcome.counts.created).toBe(450);
  });

  it('isolates a row the database refuses: the rest of its chunk still lands', async () => {
    const store = new MemoryBranchStore();
    store.failSols.add('B-7');
    const report = await review(store, Array.from({ length: 10 }, (_, i) => row({ BRANCH: `B-${i}` })));
    const { outcome } = await commit(store, report);
    expect(outcome.counts.created).toBe(9);
    expect(outcome.skipped).toEqual([{ row: expect.any(Number), solId: 'B-7', reason: expect.stringMatching(/saved for this client by someone else/) }]);
    // Never SQL or a constraint name in front of a clerk.
    expect(outcome.skipped[0].reason).not.toMatch(/UQ_|constraint|INSERT/);
  });

  it('checks geography once per distinct place, and refuses the rows of a place it cannot verify', async () => {
    const store = new MemoryBranchStore(Array.from({ length: 6 }, (_, i) => master({ solId: `G-${i}`, state: 'Tamil Nadu', region: 'SOUTH' })));
    store.badGeography.add('Keralaa');
    const report = await review(store, [
      ...Array.from({ length: 4 }, (_, i) => row({ BRANCH: `G-${i}` })),
      ...Array.from({ length: 2 }, (_, i) => row({ BRANCH: `G-${i + 4}`, STATE: 'Keralaa' })),
    ]);
    const { outcome } = await commit(store, report);
    expect(store.geographyChecks.sort()).toEqual(['Kerala|PALAKKAD|PALAKKAD', 'Keralaa|PALAKKAD|PALAKKAD'].sort());
    expect(outcome.counts.updated).toBe(4);
    expect(outcome.skipped.map((s) => s.reason)).toEqual([expect.stringMatching(/Keralaa/), expect.stringMatching(/Keralaa/)]);
  });

  it('a new branch whose place failed in the rehearsal is not written until corrected — and a correction is checked again', async () => {
    const store = new MemoryBranchStore();
    store.badGeography.add('Keralaa');
    store.badGeography.add('Tamilnad');
    const report = await review(store, [
      row({ BRANCH: 'N-1', DISTRICT: 'Thrissur' }),
      row({ BRANCH: 'B-1', STATE: 'Keralaa' }), // left as it is
      row({ BRANCH: 'B-2', STATE: 'Keralaa' }), // corrected to a real state
      row({ BRANCH: 'B-3', STATE: 'Keralaa' }), // "corrected" to another bad one
    ]);
    const rowOf = (sol: string) => String(report.rows.find((r) => r.solId === sol)!.rowNumber);
    store.geographyChecks = [];
    const { outcome } = await commit(store, report, {
      mode: 'all_valid',
      excluded: [],
      edits: { [rowOf('B-2')]: { state: 'Kerala' }, [rowOf('B-3')]: { state: 'Tamilnad' } },
    });

    expect(outcome.counts.created).toBe(2);
    expect(store.bySol('N-1')).toBeDefined();
    expect(store.bySol('B-2')).toMatchObject({ state: 'Kerala', region: 'SOUTH' });
    expect(store.bySol('B-1')).toBeUndefined();
    expect(store.bySol('B-3')).toBeUndefined();
    expect(outcome.skipped.map((s) => [s.solId, s.reason])).toEqual([
      ['B-1', expect.stringMatching(/^Not written: Could not verify 'Keralaa'/)],
      ['B-3', expect.stringMatching(/Could not verify 'Tamilnad'/)],
    ]);
    // Only the places typed over in the review are asked again; N-1 was checked in the rehearsal.
    expect(store.geographyChecks.sort()).toEqual(['Kerala|Palakkad|PALAKKAD', 'Tamilnad|Palakkad|PALAKKAD'].sort());
  });

  it('refuses, row by row, anything outside the requester\'s regions — the backstop to the request\'s check', async () => {
    const store = new MemoryBranchStore([master({ solId: 'W-1', state: 'Maharashtra', region: 'WEST' })]);
    const report = await review(store, [row(), row({ BRANCH: 'W-1', STATE: '' })]);
    const { outcome } = await commit(store, report, allValid, { regions: ['NORTH'] });
    expect(outcome.counts.created + outcome.counts.updated + outcome.counts.unchanged).toBe(0);
    expect(outcome.skipped.map((s) => s.reason)).toEqual([
      expect.stringMatching(/SOUTH region/),
      expect.stringMatching(/WEST region/),
    ]);
  });

  describe('into a project', () => {
    const project = () => target({ scopeType: 'PROJECT', projectId: 'p-1', priority: 'HIGH' });

    it('links each branch once and opens its assessment once; a re-import refreshes packets only', async () => {
      const store = new MemoryBranchStore([master({ solId: 'S-2' })]);
      const first = await review(store, [row(), row({ BRANCH: 'S-2' })], project());
      const { outcome } = await commit(store, first, allValid, { target: project() });
      expect(outcome.counts.linked).toBe(2);
      expect(store.assessments).toHaveLength(2);
      // Risk follows the project's priority for a new branch.
      expect(outcome.counts.created).toBe(1);

      const second = await review(store, [row({ Packets: 90 }), row({ BRANCH: 'S-2', Packets: 58 })], project());
      const again = await commit(store, second, allValid, { target: project() });
      expect(again.outcome.counts.linked).toBe(0);
      expect(store.links).toHaveLength(2);
      expect(store.assessments).toHaveLength(2);
      expect(store.links.find((l) => l.branchId === store.bySol('S-1')!.id)!.packetCount).toBe(90);
    });
  });

  it('converges when run again from the top (a worker restarted mid-commit)', async () => {
    const store = new MemoryBranchStore();
    const report = await review(store, Array.from({ length: 30 }, (_, i) => row({ BRANCH: `R-${i}` })));
    const once = await commit(store, report);
    const twice = await commit(store, report);
    expect(once.outcome.counts.created).toBe(30);
    expect(twice.outcome.counts).toMatchObject({ created: 0, updated: 0, unchanged: 30 });
    expect(store.branches.size).toBe(30);
    // Nothing to write → no transaction at all the second time.
    expect(store.chunks).toEqual([30]);
  });

  it('stops between chunks when cancelled, keeping and reporting what it wrote', async () => {
    const store = new MemoryBranchStore();
    const report = await review(store, Array.from({ length: 500 }, (_, i) => row({ BRANCH: `C-${i}` })));
    const { outcome } = await commit(store, report, allValid, { shouldStop: async () => store.chunks.length >= 1 });
    expect(outcome.stoppedEarly).toBe(true);
    expect(outcome.saved).toBe(200);
    expect(outcome.counts.created).toBe(200);
    expect(store.branches.size).toBe(200);
  });
});

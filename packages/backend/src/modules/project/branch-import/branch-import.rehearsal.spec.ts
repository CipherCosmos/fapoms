import { branchReviewStatus } from '@fapoms/shared';
import { rehearseBranchImport, geocodeKey } from './branch-import.rehearsal';
import { countingLookups, master, MemoryBranchStore, parsed, quietHooks, target } from './branch-import.fixtures';

const row = (overrides: Record<string, unknown> = {}) => ({
  BRANCH: 'S-1',
  BRANCH_NAME: 'Thenkurissi',
  DISTRICT: 'Palakkad',
  STATE: 'Kerala',
  'Branch Address': '1 Main Road, Thenkurissi 678671',
  Packets: 58,
  ...overrides,
});

describe('branch import rehearsal', () => {
  it('writes nothing and describes every row for review', async () => {
    const store = new MemoryBranchStore([master({ solId: 'S-2' })]);
    const { lookups } = countingLookups();
    const { report } = await rehearseBranchImport(
      parsed([row(), row({ BRANCH: 'S-2', BRANCH_NAME: 'Known' })]), target(), store.reads(), lookups, quietHooks(),
    );

    expect(report.version).toBe(1);
    expect(report.rows.map((r) => [r.solId, r.existsInMaster])).toEqual([['S-1', false], ['S-2', true]]);
    expect(report.summary).toMatchObject({ totalRows: 2, existingInMaster: 1, newBranches: 1 });
    expect(store.chunks).toEqual([]);
  });

  it('numbers rows as the person sees them, counting a title above the header', async () => {
    const store = new MemoryBranchStore();
    const { lookups } = countingLookups();
    const { report } = await rehearseBranchImport(
      parsed([row(), row({ BRANCH: 'S-9' })], { titleRow: true }), target(), store.reads(), lookups, quietHooks(),
    );
    // Title on row 1, blank row 2, header row 3 → the data starts on row 4.
    expect(report.rows.map((r) => r.rowNumber)).toEqual([4, 5]);
  });

  it('sets a repeated SOL ID aside and names the row it repeats', async () => {
    const store = new MemoryBranchStore();
    const { lookups } = countingLookups();
    const { report } = await rehearseBranchImport(
      parsed([row(), row({ BRANCH_NAME: 'Second copy' }), row({ BRANCH: 's-1', BRANCH_NAME: 'Lower case copy' })]),
      target(), store.reads(), lookups, quietHooks(),
    );
    expect(report.rows).toHaveLength(1);
    expect(report.skipped).toEqual([
      { row: 3, solId: 'S-1', reason: expect.stringMatching(/Duplicate of row 2/) },
      { row: 4, solId: 's-1', reason: expect.stringMatching(/Duplicate of row 2/) },
    ]);
  });

  it('names a column nobody read, so its data is not lost in silence', async () => {
    const store = new MemoryBranchStore();
    const { lookups } = countingLookups();
    const { report } = await rehearseBranchImport(
      parsed([row({ 'Branch Head Mobile': '98765' })]), target(), store.reads(), lookups, quietHooks(),
    );
    expect(report.notes.join(' ')).toMatch(/Column "Branch Head Mobile" was not recognised/);
  });

  describe('asks the IFSC directory only when a row still lacks what it would supply', () => {
    it('never asks for a row whose state, district and address are all known — IFSC column or not', async () => {
      const store = new MemoryBranchStore();
      const { lookups, calls } = countingLookups();
      await rehearseBranchImport(
        parsed([row({ IFSC: 'SBIN0000001' }), row({ BRANCH: 'S-2' })]), target(), store.reads(), lookups, quietHooks(),
      );
      expect(calls.ifsc).toEqual([]);
    });

    it('never asks for a known branch the master already completes', async () => {
      const store = new MemoryBranchStore([master({ solId: 'S-1' })]);
      const { lookups, calls } = countingLookups();
      const { report } = await rehearseBranchImport(
        parsed([{ BRANCH: 'S-1', BRANCH_NAME: 'Thenkurissi' }]), target(), store.reads(), lookups, quietHooks(),
      );
      expect(calls.ifsc).toEqual([]);
      expect(report.rows[0]).toMatchObject({ state: 'Kerala', district: 'PALAKKAD', existsInMaster: true });
    });

    it('asks once per distinct code, and fills the gaps from the answer', async () => {
      const store = new MemoryBranchStore();
      const { lookups, calls } = countingLookups();
      const rows = [
        { BRANCH: '101', BRANCH_NAME: 'A' },
        { BRANCH: '102', BRANCH_NAME: 'B', IFSC: 'SBIN0000555' },
        { BRANCH: '103', BRANCH_NAME: 'C', IFSC: 'SBIN0000555' },
      ];
      const { report } = await rehearseBranchImport(parsed(rows), target(), store.reads(), lookups, quietHooks());
      // 101 is inferred from the client's bank code; 102 and 103 share one explicit code.
      expect(calls.ifsc.sort()).toEqual(['SBIN0000101', 'SBIN0000555']);
      expect(report.rows[0]).toMatchObject({ state: 'Kerala', district: 'THRISSUR', address: 'IFSC address for SBIN0000101' });
      expect(report.rows[0].phone).toBe('0487-2333333');
    });
  });

  it('asks India Post once per distinct pincode, and only for rows missing a state or district', async () => {
    const store = new MemoryBranchStore();
    const { lookups, calls } = countingLookups();
    // Name-only bank so no IFSC can be inferred and the pincode is the only way to a state.
    const rows = [
      { BRANCH: 'A1', BRANCH_NAME: 'A', 'Branch Address': 'x', Pincode: '678001' },
      { BRANCH: 'A2', BRANCH_NAME: 'B', 'Branch Address': 'y', Pincode: '678001' },
      { BRANCH: 'A3', BRANCH_NAME: 'C', 'Branch Address': 'z', Pincode: '678002' },
      { BRANCH: 'A4', BRANCH_NAME: 'D', 'Branch Address': 'w', Pincode: '678003', STATE: 'Kerala', DISTRICT: 'Palakkad' },
    ];
    const { report } = await rehearseBranchImport(
      parsed(rows), target({ clientName: 'Some Cooperative', bankCode: null }), store.reads(), lookups, quietHooks(),
    );
    expect(calls.pincode.sort()).toEqual(['678001', '678002']);
    expect(report.rows.every((r) => r.state === 'Kerala')).toBe(true);
  });

  it('places branches once per distinct place, not once per row', async () => {
    const store = new MemoryBranchStore();
    const { lookups, calls } = countingLookups();
    const rows = Array.from({ length: 60 }, (_, i) => row({
      BRANCH: `N-${i}`,
      'Branch Address': `${i} Temple Street, Palakkad ${678001 + (i % 3)}`,
    }));
    const { lookups: counted } = await rehearseBranchImport(parsed(rows), target(), store.reads(), lookups, quietHooks());
    // Without a Google key the fast tiers answer from pincode + district + state: three places.
    expect(calls.geocode).toHaveLength(3);
    expect(counted.geocode).toBe(3);
  });

  it('keeps the street address in the question when the geocoder would use it', () => {
    const a = { address: '1 A St', name: 'A', district: 'D', state: 'S', pincode: '678001' };
    const b = { ...a, address: '2 B St' };
    expect(geocodeKey(a, false)).toBe(geocodeKey(b, false));
    expect(geocodeKey(a, true)).not.toBe(geocodeKey(b, true));
  });

  describe('a hand-placed pin', () => {
    it('is not overridden by a bare Latitude/Longitude pair in the sheet', async () => {
      const store = new MemoryBranchStore([master({ solId: 'S-1', geoSource: 'manual', latitude: 10.1, longitude: 76.1 })]);
      const { lookups } = countingLookups();
      const { report } = await rehearseBranchImport(
        parsed([row({ Latitude: 11.5, Longitude: 77.5 })]), target(), store.reads(), lookups, quietHooks(),
      );
      expect(report.rows[0]).toMatchObject({ latitude: 10.1, longitude: 76.1, geoSource: 'manual', status: 'ready' });
      expect(report.rows[0].warnings?.join(' ')).toMatch(/pinned by hand/);
    });

    it('survives an address change, which re-places only a branch nobody pinned', async () => {
      const store = new MemoryBranchStore([
        master({ solId: 'P-1', geoSource: 'manual', latitude: 10.1, longitude: 76.1 }),
        master({ solId: 'P-2' }),
      ]);
      const { lookups, calls } = countingLookups();
      const moved = { 'Branch Address': 'New Road, Palakkad 678009' };
      const { report } = await rehearseBranchImport(
        parsed([row({ BRANCH: 'P-1', ...moved }), row({ BRANCH: 'P-2', ...moved })]), target(), store.reads(), lookups, quietHooks(),
      );
      expect(report.rows[0]).toMatchObject({ latitude: 10.1, geoSource: 'manual' });
      expect(report.rows[1]).toMatchObject({ latitude: 10.5, geoSource: 'pincode' });
      expect(calls.geocode).toHaveLength(1);
    });
  });

  it('flags another bank\'s rows from the file itself, the IFSC prefix, the name and the master', async () => {
    const store = new MemoryBranchStore();
    store.others = [{ solId: 'X-4', clientId: 'client-2', clientName: 'HDFC Bank', name: 'HDFC Kochi' }];
    const { lookups } = countingLookups();
    const { report } = await rehearseBranchImport(parsed([
      row({ BRANCH: 'X-1', BANK: 'HDFC Bank' }),
      row({ BRANCH: 'X-2', IFSC: 'HDFC0001234' }),
      row({ BRANCH: 'X-3', BRANCH_NAME: 'ICICI Bank Palakkad' }),
      row({ BRANCH: 'X-4' }),
      row({ BRANCH: 'X-5' }),
    ]), target(), store.reads(), lookups, quietHooks());

    const [a, b, c, d, e] = report.rows;
    expect(a.clientMismatch?.severity).toBe('critical');
    expect(b.clientMismatch?.severity).toBe('critical');
    expect(c.clientMismatch?.severity).toBe('critical');
    expect(d.clientMismatch?.severity).toBe('warning');
    expect(e.clientMismatch).toBeUndefined();
    expect([a, b, c].every((r) => r.status === 'needs_details')).toBe(true);
    expect(report.summary.clientMismatchCount).toBe(4);
  });

  it('warns about a pincode that is not one, while it can still be corrected', async () => {
    const store = new MemoryBranchStore();
    const { lookups } = countingLookups();
    const { report } = await rehearseBranchImport(parsed([row({ Pincode: 'ABCDE' })]), target(), store.reads(), lookups, quietHooks());
    expect(report.rows[0].warnings?.join(' ')).toMatch(/"ABCDE" is not a valid pincode/);
  });

  it('checks a NEW branch\'s state and district once per distinct place, and leaves a failing row for the person to fix', async () => {
    const store = new MemoryBranchStore([master({ solId: 'K-1', state: 'Kerala' })]);
    store.badGeography.add('Keralaa');
    const { lookups } = countingLookups();
    const { report, lookups: asked } = await rehearseBranchImport(
      parsed([
        ...Array.from({ length: 3 }, (_, i) => row({ BRANCH: `N-${i}` })),
        ...Array.from({ length: 2 }, (_, i) => row({ BRANCH: `B-${i}`, STATE: 'Keralaa' })),
        row({ BRANCH: 'K-1', STATE: 'Keralaa' }), // known: its move is checked at commit, as before
      ]),
      target(), store.reads(), lookups, quietHooks(),
    );

    // Two distinct places among the five new rows; the known branch is not asked here.
    expect(store.geographyChecks.sort()).toEqual(['Kerala|Palakkad|PALAKKAD', 'Keralaa|Palakkad|PALAKKAD'].sort());
    expect(asked.geography).toBe(2);

    const bySol = new Map(report.rows.map((r) => [r.solId, r]));
    for (const sol of ['N-0', 'N-1', 'N-2']) {
      expect(bySol.get(sol)).toMatchObject({ status: 'coarse' });
      expect(bySol.get(sol)!.geographyProblem).toBeUndefined();
    }
    for (const sol of ['B-0', 'B-1']) {
      const r = bySol.get(sol)!;
      expect(r.status).toBe('needs_details');
      expect(r.geographyProblem).toEqual({ state: 'Keralaa', district: 'Palakkad', reason: expect.stringMatching(/Could not verify 'Keralaa'/) });
      expect(r.warnings?.join(' ')).toMatch(/Correct the state or district here, or this row will be skipped/);
    }
    expect(bySol.get('K-1')!.geographyProblem).toBeUndefined();
    expect(report.summary.needsDetailsCount).toBe(2);
  });

  it('a bad district on a new branch is caught too, and typing over it clears the flag', async () => {
    const store = new MemoryBranchStore();
    store.badGeography.add('Nowhere');
    const { lookups } = countingLookups();
    const { report } = await rehearseBranchImport(parsed([row({ DISTRICT: 'Nowhere' })]), target(), store.reads(), lookups, quietHooks());
    const flagged = report.rows[0];
    expect(flagged.status).toBe('needs_details');
    expect(flagged.geographyProblem?.reason).toMatch(/Nowhere/);
    expect(branchReviewStatus({ ...flagged, district: 'Palakkad' })).toBe('coarse');
  });

  it('reports every region the rows touch, including where matched branches already are', async () => {
    const store = new MemoryBranchStore([master({ solId: 'W-1', region: 'WEST', state: 'Maharashtra' })]);
    const { lookups } = countingLookups();
    const { regions } = await rehearseBranchImport(
      parsed([row(), row({ BRANCH: 'W-1', STATE: 'Kerala' })]), target(), store.reads(), lookups, quietHooks(),
    );
    expect([...regions].sort()).toEqual(['SOUTH', 'WEST']);
  });

  it('stops between lookups when cancelled, before asking every question', async () => {
    const store = new MemoryBranchStore();
    const { lookups, calls } = countingLookups();
    let checks = 0;
    const hooks = quietHooks({
      throwIfCancelled: async () => {
        if (++checks > 3) throw new Error('Cancelled.');
      },
    });
    const rows = Array.from({ length: 40 }, (_, i) => row({ BRANCH: `C-${i}`, 'Branch Address': `x ${600000 + i + 100}` }));
    await expect(rehearseBranchImport(parsed(rows), target(), store.reads(), lookups, hooks)).rejects.toThrow('Cancelled.');
    expect(calls.geocode.length).toBeLessThan(40);
  });
});

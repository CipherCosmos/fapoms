import { resolveBranchHeaders } from './branch.service';

/**
 * A branch file is uploaded as the bank sent it — headers matched loosely, never forced to an
 * exact name. Casing, spaces and underscores never matter; a client's explicit importMapping
 * still wins where set.
 */
describe('resolveBranchHeaders — tolerant branch-file headers', () => {
  it("reads the operator's real file: BRANCH / BRANCH_NAME / City / STATE / Branch Address / Latitude / Longitude", () => {
    const f = resolveBranchHeaders(['BRANCH', 'BRANCH_NAME', 'City ', 'STATE', 'Branch Address', 'Latitude', 'Longitude']);
    expect(f.branchCode).toBe('BRANCH');
    expect(f.name).toBe('BRANCH_NAME');
    expect(f.city).toBe('City ');       // trailing space and all
    expect(f.state).toBe('STATE');
    expect(f.address).toBe('Branch Address');
    expect(f.latitude).toBe('Latitude');
    expect(f.longitude).toBe('Longitude');
    expect(f.district).toBeUndefined(); // absent, and no longer required
  });

  it.each(['SOL ID', 'Sol Id', 'sol_id', 'SOL-ID', 'SolID', 'sol id'])(
    'matches the SOL id however it is written: "%s"',
    (header) => {
      const f = resolveBranchHeaders(['Branch Code', header]);
      expect(f.solId).toBe(header);
    },
  );

  it('reads the system\'s own standard headings unchanged', () => {
    const f = resolveBranchHeaders(['Branch Code', 'SOL ID', 'Branch Name', 'Address', 'State', 'District', 'City', 'Pincode']);
    expect(f).toMatchObject({
      branchCode: 'Branch Code', solId: 'SOL ID', name: 'Branch Name',
      address: 'Address', state: 'State', district: 'District', city: 'City', pincode: 'Pincode',
    });
  });

  it('a client\'s explicit mapping overrides the aliases', () => {
    // This bank calls the code column "Unit", which no alias would guess.
    const f = resolveBranchHeaders(['Unit', 'BRANCH_NAME', 'STATE'], { branchCode: 'Unit' });
    expect(f.branchCode).toBe('Unit');
    expect(f.name).toBe('BRANCH_NAME');
  });

  it('leaves a field unmapped when nothing matches, rather than guessing', () => {
    const f = resolveBranchHeaders(['Mystery', 'BRANCH_NAME', 'STATE']);
    expect(f.branchCode).toBeUndefined();
    expect(f.name).toBe('BRANCH_NAME');
    expect(f.state).toBe('STATE');
  });
});

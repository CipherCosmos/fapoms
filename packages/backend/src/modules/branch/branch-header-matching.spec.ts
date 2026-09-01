import { resolveBranchHeaders } from './branch.service';

/**
 * A branch file is uploaded as the bank sent it — headers matched loosely, never forced to an
 * exact name. Casing, spaces and underscores never matter; a client's explicit importMapping
 * still wins where set. A branch's identity is its SOL id, and the column that carries it is named
 * differently by every bank — "SOL ID", or the plain "BRANCH"/"Branch Code" that holds the same
 * number — so all of those resolve to `solId`.
 */
describe('resolveBranchHeaders — tolerant branch-file headers', () => {
  it("reads the operator's real file: BRANCH / BRANCH_NAME / City / STATE / Branch Address / Latitude / Longitude", () => {
    const f = resolveBranchHeaders(['BRANCH', 'BRANCH_NAME', 'City ', 'STATE', 'Branch Address', 'Latitude', 'Longitude']);
    expect(f.solId).toBe('BRANCH');     // the "BRANCH" column IS the SOL id
    expect(f.name).toBe('BRANCH_NAME');
    expect(f.city).toBe('City ');       // trailing space and all
    expect(f.state).toBe('STATE');
    expect(f.address).toBe('Branch Address');
    expect(f.latitude).toBe('Latitude');
    expect(f.longitude).toBe('Longitude');
    expect(f.district).toBeUndefined(); // absent, and no longer required
  });

  it.each(['SOL ID', 'Sol Id', 'sol_id', 'SOL-ID', 'SolID', 'sol id', 'BRANCH', 'Branch Code'])(
    'matches the SOL id however the column is named: "%s"',
    (header) => {
      const f = resolveBranchHeaders([header]);
      expect(f.solId).toBe(header);
    },
  );

  it('reads the system\'s own standard headings unchanged', () => {
    const f = resolveBranchHeaders(['SOL ID', 'Branch Name', 'Address', 'State', 'District', 'City', 'Pincode']);
    expect(f).toMatchObject({
      solId: 'SOL ID', name: 'Branch Name',
      address: 'Address', state: 'State', district: 'District', city: 'City', pincode: 'Pincode',
    });
  });

  it('a client\'s explicit mapping overrides the aliases', () => {
    // This bank calls the SOL id column "Unit", which no alias would guess.
    const f = resolveBranchHeaders(['Unit', 'BRANCH_NAME', 'STATE'], { solId: 'Unit' });
    expect(f.solId).toBe('Unit');
    expect(f.name).toBe('BRANCH_NAME');
  });

  it('leaves a field unmapped when nothing matches, rather than guessing', () => {
    const f = resolveBranchHeaders(['Mystery', 'BRANCH_NAME', 'STATE']);
    expect(f.solId).toBeUndefined();
    expect(f.name).toBe('BRANCH_NAME');
    expect(f.state).toBe('STATE');
  });
});

import {
  applyBranchDecisions,
  branchReviewStatus,
  diffBranchDecisions,
  type BranchReviewRow,
} from './branch-import';
import { backgroundJobReviewsOnPage, backgroundJobRoute } from './background-jobs';

const row = (over: Partial<BranchReviewRow> = {}): BranchReviewRow => ({
  rowNumber: 2, solId: 'S-1', name: 'A', state: 'Kerala', district: 'X', address: 'Y',
  latitude: 10, longitude: 76, geoSource: 'pincode', geoAccuracyMeters: 5000, existsInMaster: false,
  status: 'coarse', missingFields: [], ...over,
});

describe('the review rules the screen and the commit share', () => {
  it('rates readiness the same way everywhere', () => {
    expect(branchReviewStatus(row())).toBe('coarse');
    expect(branchReviewStatus(row({ geoSource: 'manual' }))).toBe('ready');
    expect(branchReviewStatus(row({ geoAccuracyMeters: 250 }))).toBe('ready');
    expect(branchReviewStatus(row({ state: undefined }))).toBe('needs_details');
    expect(branchReviewStatus(row({ clientMismatch: { expectedBank: 'SBI', reason: 'x', severity: 'critical' } }))).toBe('needs_details');
  });

  it('a place the geography check refused needs attention until the state or district is typed over', () => {
    const geographyProblem = { state: 'Keralaa', district: 'Palakkad', reason: "Could not verify 'Keralaa' as a real state." };
    const flagged = row({ state: 'Keralaa', district: 'Palakkad', geographyProblem });
    expect(branchReviewStatus(flagged)).toBe('needs_details');
    // Case and spacing are not a correction.
    expect(branchReviewStatus({ ...flagged, state: ' keralaa ', district: 'PALAKKAD' })).toBe('needs_details');
    expect(branchReviewStatus({ ...flagged, state: 'Kerala' })).toBe('coarse');
    expect(branchReviewStatus({ ...flagged, district: 'Thrissur' })).toBe('coarse');

    // Left as it was, the commit names the reason rather than "missing details".
    const applied = applyBranchDecisions([{ ...flagged, status: 'needs_details' }], { mode: 'all_valid', excluded: [], edits: {} });
    expect(applied.rows).toEqual([]);
    expect(applied.left).toEqual([{ row: 2, solId: 'S-1', reason: "Not written: Could not verify 'Keralaa' as a real state." }]);
    // Corrected in the review, it goes through to the commit (which checks the new pair itself).
    expect(applyBranchDecisions([flagged], { mode: 'all_valid', excluded: [], edits: { 2: { state: 'Kerala' } } }).rows).toHaveLength(1);
  });

  it('sends only what changed, and applying it reproduces the edited rows', () => {
    const stored = [row(), row({ rowNumber: 3, solId: 'S-2', state: undefined, status: 'needs_details' }), row({ rowNumber: 4, solId: 'S-3' })];
    const edited = [
      { ...stored[0], latitude: 11, longitude: 77, geoSource: 'manual', geoAccuracyMeters: 5 },
      { ...stored[1], state: 'Kerala' },
    ];
    const decisions = diffBranchDecisions(stored, edited, 'all_valid');
    expect(decisions).toEqual({
      mode: 'all_valid',
      excluded: [4],
      edits: { 2: { latitude: 11, longitude: 77 }, 3: { state: 'Kerala' } },
    });

    const applied = applyBranchDecisions(stored, decisions);
    expect(applied.rows.map((r) => [r.solId, r.state, r.geoSource, r.status])).toEqual([
      ['S-1', 'Kerala', 'manual', 'ready'],
      ['S-2', 'Kerala', 'pincode', 'coarse'],
    ]);
    expect(applied.removed.map((r) => r.row)).toEqual([4]);
  });

  it('ignores anything in an edit that is not an editable field or a pin', () => {
    const applied = applyBranchDecisions([row()], {
      mode: 'all_valid', excluded: [], edits: { 2: { geoSource: 'google', region: 'NORTH', existsInMaster: true } as never },
    });
    expect(applied.rows[0]).toMatchObject({ geoSource: 'pincode', existsInMaster: false });
    expect(applied.rows[0]).not.toHaveProperty('region');
  });

  it('refuses a pin the caller\'s own test says is not plausible, for that row only', () => {
    const applied = applyBranchDecisions([row(), row({ rowNumber: 3 })], {
      mode: 'all_valid', excluded: [], edits: { 2: { latitude: 51, longitude: 0 } },
    }, (lat) => lat < 40);
    expect(applied.rows.map((r) => r.rowNumber)).toEqual([3]);
    expect(applied.left[0].reason).toMatch(/not a location in India/);
  });

  it('marks rows an edit moved, so the server places them again', () => {
    const applied = applyBranchDecisions([row()], { mode: 'all_valid', excluded: [], edits: { 2: { address: 'New road' } } });
    expect([...applied.movedByEdit]).toEqual([2]);
  });
});

describe('branch import jobs lead back to their page', () => {
  it('deep-links the client or project, and is reviewed there rather than from the tray', () => {
    expect(backgroundJobRoute({ kind: 'BRANCH_IMPORT', scopeType: 'CLIENT', scopeId: 'c-1' })).toBe('/branches?client=c-1');
    expect(backgroundJobRoute({ kind: 'BRANCH_IMPORT', scopeType: 'PROJECT', scopeId: 'p-1' })).toBe('/projects?id=p-1&tab=branches');
    expect(backgroundJobReviewsOnPage('BRANCH_IMPORT')).toBe(true);
    expect(backgroundJobReviewsOnPage('ROSTER_IMPORT')).toBe(false);
  });
});

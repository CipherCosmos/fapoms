import { impliedPermissionNote, withImpliedPermissions } from './permission-implications';

/**
 * 2026-09-24 audit (P12): a custom HOD role holding only the final billing approval could not open
 * the Billing page it approves on. Ticking the approval now ticks "View" on Billing with it.
 */
const catalogue = [
  { id: 'view', resource: 'BILLING', action: 'VIEW', scope: 'ORGANIZATION' },
  { id: 'final', resource: 'BILLING', action: 'FINAL_APPROVE', scope: 'ORGANIZATION' },
  { id: 'other', resource: 'PROJECT', action: 'VIEW', scope: 'ORGANIZATION' },
];

describe('permissions the role editor adds for you', () => {
  it('ticking the final approval ticks billing view', () => {
    expect([...withImpliedPermissions(new Set(['final']), catalogue)].sort()).toEqual(['final', 'view']);
  });

  it('never adds anything for an unrelated permission, and never removes', () => {
    expect([...withImpliedPermissions(new Set(['other']), catalogue)]).toEqual(['other']);
    expect([...withImpliedPermissions(new Set(['view']), catalogue)]).toEqual(['view']);
  });

  it('explains itself only when the approval is ticked', () => {
    expect(impliedPermissionNote(new Set(['final', 'view']), catalogue)).toMatch(/View/);
    expect(impliedPermissionNote(new Set(['view']), catalogue)).toBeNull();
  });
});

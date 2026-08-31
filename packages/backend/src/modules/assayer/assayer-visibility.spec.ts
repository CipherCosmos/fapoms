import { SystemRole } from '@fapoms/shared';
import { scopeAssayerForRoles, scopeAssayerListForRoles, rolesOf } from './assayer-visibility';

const record = {
  id: 'a1',
  assayerCode: 'AS0001',
  displayName: 'Test Assayer',
  city: 'Pune',
  panNumber: 'ABCDE1234F',
  aadhaarNumber: '1111 2222 3333',
  dateOfBirth: '1990-01-01',
  emergencyContactName: 'Next Of Kin',
  emergencyContactPhone: '9999999999',
  bankAccountNumber: '123456789',
  ifscCode: 'HDFC0000123',
  passwordHash: '$2b$10$hash',
  // The roster's free-text Remarks column, as the importer files it. Real values in this
  // column include "Husband doing audit" and termination reasons.
  notes: 'Husband doing the audit at this branch — do not plan together.',
};

describe('assayer field visibility', () => {
  it('never returns the password hash, even to a super administrator', () => {
    const out = scopeAssayerForRoles(record, [SystemRole.ADMIN]);
    expect(out).not.toHaveProperty('passwordHash');
  });

  it.each([SystemRole.ADMIN, SystemRole.OPERATIONS])(
    '%s sees identity and banking — they onboard assayers and pay them',
    (role) => {
      const out = scopeAssayerForRoles(record, [role]) as any;
      expect(out.panNumber).toBe('ABCDE1234F');
      expect(out.bankAccountNumber).toBe('123456789');
      expect(out.emergencyContactPhone).toBe('9999999999');
    },
  );

  /**
   * The widening this consolidation cost, stated as a test rather than left implicit.
   *
   * These were three roles: a planner who could read neither identity nor banking, an HR
   * manager who read identity, and a finance manager who read banking. They are one role now,
   * so it reads both — you cannot verify a new joiner's documents or pay into their account
   * without seeing them. If the team ever splits those jobs again, this is the test that should
   * fail first.
   */
  it('is the only staff role that sees an assayer as a person rather than a resource', () => {
    for (const role of [SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR]) {
      const out = scopeAssayerForRoles(record, [role]) as any;
      // Enough to know who did the work...
      expect(out.displayName).toBe('Test Assayer');
      expect(out.city).toBe('Pune');
      // ...and nothing about who they are.
      expect(out).not.toHaveProperty('panNumber');
      expect(out).not.toHaveProperty('aadhaarNumber');
      expect(out).not.toHaveProperty('bankAccountNumber');
      expect(out).not.toHaveProperty('emergencyContactPhone');
    }
  });

  it.each([SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR])(
    '%s never sees HR\u2019s private notes about a person',
    (role) => {
      const out = scopeAssayerForRoles(record, [role]) as any;
      expect(out).not.toHaveProperty('notes');
    },
  );

  it('an assayer does NOT see the notes written about them, even on their own record', () => {
    // The one category `isSelf` does not open: staff-private text is not the subject's to read.
    const out = scopeAssayerForRoles(record, [SystemRole.ASSAYER], true) as any;
    expect(out).not.toHaveProperty('notes');
    // ...while their own identity and banking still come through.
    expect(out.panNumber).toBe('ABCDE1234F');
  });

  it.each([SystemRole.ADMIN, SystemRole.OPERATIONS])('%s does see the notes \u2014 they manage the person', (role) => {
    const out = scopeAssayerForRoles(record, [role]) as any;
    expect(out.notes).toContain('Husband doing the audit');
  });

  it('an assayer sees their own banking and identity', () => {
    const out = scopeAssayerForRoles(record, [SystemRole.ASSAYER], true) as any;
    expect(out.bankAccountNumber).toBe('123456789');
    expect(out.panNumber).toBe('ABCDE1234F');
    expect(out).not.toHaveProperty('passwordHash');
  });

  it('an assayer sees nothing sensitive about a colleague', () => {
    const out = scopeAssayerForRoles(record, [SystemRole.ASSAYER], false) as any;
    expect(out.displayName).toBe('Test Assayer');
    expect(out).not.toHaveProperty('bankAccountNumber');
    expect(out).not.toHaveProperty('panNumber');
  });

  it('scopes a list per row, unmasking only the caller’s own record', () => {
    const rows = [record, { ...record, id: 'a2', assayerCode: 'AS0002' }];
    const out = scopeAssayerListForRoles(rows, [SystemRole.ASSAYER], 'a1') as any[];
    expect(out[0].bankAccountNumber).toBe('123456789');
    expect(out[1]).not.toHaveProperty('bankAccountNumber');
  });

  it('reads role names from both staff role entities and assayer token roles', () => {
    expect(rolesOf({ roles: [{ name: 'OPERATIONS' }] })).toEqual(['OPERATIONS']);
    expect(rolesOf({ roles: ['ASSAYER'] })).toEqual(['ASSAYER']);
    expect(rolesOf(undefined)).toEqual([]);
    expect(rolesOf({ roles: [null, { name: 'ADMIN' }] })).toEqual(['ADMIN']);
  });
});

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
};

describe('assayer field visibility', () => {
  it('never returns the password hash, even to a super administrator', () => {
    const out = scopeAssayerForRoles(record, [SystemRole.SUPER_ADMINISTRATOR]);
    expect(out).not.toHaveProperty('passwordHash');
  });

  it.each([SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER])(
    '%s sees identity and banking — they own the workforce record',
    (role) => {
      const out = scopeAssayerForRoles(record, [role]) as any;
      expect(out.panNumber).toBe('ABCDE1234F');
      expect(out.bankAccountNumber).toBe('123456789');
      expect(out.emergencyContactPhone).toBe('9999999999');
    },
  );

  it('operations can plan with the record but cannot read identity or banking', () => {
    const out = scopeAssayerForRoles(record, [SystemRole.OPERATIONS_MANAGER]) as any;
    expect(out.displayName).toBe('Test Assayer');
    expect(out.city).toBe('Pune');
    expect(out).not.toHaveProperty('panNumber');
    expect(out).not.toHaveProperty('aadhaarNumber');
    expect(out).not.toHaveProperty('bankAccountNumber');
    expect(out).not.toHaveProperty('emergencyContactPhone');
  });

  it('finance sees banking (they disburse) but not identity documents', () => {
    const out = scopeAssayerForRoles(record, [SystemRole.FINANCE_MANAGER]) as any;
    expect(out.bankAccountNumber).toBe('123456789');
    expect(out.ifscCode).toBe('HDFC0000123');
    expect(out).not.toHaveProperty('panNumber');
    expect(out).not.toHaveProperty('aadhaarNumber');
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
    expect(rolesOf({ roles: [{ name: 'HR_MANAGER' }] })).toEqual(['HR_MANAGER']);
    expect(rolesOf({ roles: ['ASSAYER'] })).toEqual(['ASSAYER']);
    expect(rolesOf(undefined)).toEqual([]);
    expect(rolesOf({ roles: [null, { name: 'ADMINISTRATOR' }] })).toEqual(['ADMINISTRATOR']);
  });
});

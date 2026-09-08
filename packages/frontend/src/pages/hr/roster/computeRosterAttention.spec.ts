import { describe, it, expect } from '@jest/globals';
import { AssayerLifecycleStatus } from '@fapoms/shared';
import { computeRosterAttention } from './computeRosterAttention';
import type { RosterPerson } from '../roster-filters';

const basePerson = (overrides: Partial<RosterPerson> = {}): RosterPerson => ({
  id: 'p-1',
  assayerCode: 'AS0001',
  employeeId: null,
  employeeCode: null,
  firstName: 'Test',
  lastName: 'Assayer',
  displayName: 'Test Assayer',
  email: 'test@example.com',
  phone: '9876543210',
  alternatePhone: null,
  address: '123 Test St',
  state: 'Maharashtra',
  district: 'Pune',
  city: 'Pune',
  pincode: '411001',
  latitude: 18.52,
  longitude: 73.85,
  status: 'ACTIVE',
  lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
  organizationId: 'org-1',
  panNumber: 'ABCDE1234F',
  bankAccountNumber: '123456789012',
  ifscCode: 'HDFC0001234',
  notes: null,
  employmentType: 'REGULAR',
  joiningDate: '2024-01-01',
  exitDate: null,
  terminationDate: null,
  managerId: null,
  department: null,
  region: 'West',
  emergencyContactName: 'Contact Person',
  emergencyContactPhone: '9876543211',
  emergencyContactRelation: 'Spouse',
  photograph: null,
  skills: ['Gold Appraisal'],
  certifications: [{ name: 'Certified Assayer', expiryDate: '2028-12-31' }],
  languages: ['English', 'Hindi'],
  preferredRegions: ['Pune'],
  specializations: [],
  experienceYears: 5,
  performanceRating: 4.5,
  leaves: null,
  workingHours: null,
  maxDailyWorkload: 5,
  maxWeeklyWorkload: 25,
  ...overrides,
});

describe('computeRosterAttention — deterministic domain classification', () => {
  it('classifies joining candidates awaiting document review as ACTION_REQUIRED', () => {
    const candidate = basePerson({
      lifecycleStatus: AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
      documents: {
        required: 3,
        withScan: 3,
        verified: 1,
        awaitingVerdict: 2,
      },
    });

    const result = computeRosterAttention(candidate);
    expect(result.state).toBe('ACTION_REQUIRED');
    expect(result.reason).toContain('awaiting reviewer verification');
  });

  it('classifies candidates awaiting background verification as ACTION_REQUIRED', () => {
    const candidate = basePerson({
      lifecycleStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
    });

    const result = computeRosterAttention(candidate);
    expect(result.state).toBe('ACTION_REQUIRED');
    expect(result.reason).toContain('background verification');
  });

  it('classifies active workable assayers with missing bank credentials as PAYOUT_BLOCKED', () => {
    const activeMissingBank = basePerson({
      lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
      bankAccountNumber: null,
    });

    const result = computeRosterAttention(activeMissingBank);
    expect(result.state).toBe('PAYOUT_BLOCKED');
    expect(result.reason).toContain('Missing mandatory payout credentials');
  });

  it('never marks non-workable or departed records as PAYOUT_BLOCKED even if bank details are missing', () => {
    const departed = basePerson({
      lifecycleStatus: AssayerLifecycleStatus.TERMINATED,
      terminationDate: '2024-06-01',
      bankAccountNumber: null,
      panNumber: null,
    });

    const result = computeRosterAttention(departed);
    expect(result.state).not.toBe('PAYOUT_BLOCKED');
    expect(result.state).toBe('NORMAL');
  });

  it('classifies active assayers with expired certification as EMPANELMENT_ISSUE with cert reason', () => {
    const expiredCert = basePerson({
      lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
      certifications: [{ name: 'Bureau of Standards', expiryDate: '2023-01-01' }],
    });

    const result = computeRosterAttention(expiredCert);
    expect(result.state).toBe('EMPANELMENT_ISSUE');
    expect(result.reason).toBe('Professional certification has expired');
  });

  it('classifies active assayers with 0 plannable client banks as EMPANELMENT_ISSUE with bank reason', () => {
    const zeroPlannable = basePerson({
      lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
      empanelment: {
        clientCount: 2,
        plannableClients: 0,
      },
    } as any);

    const result = computeRosterAttention(zeroPlannable);
    expect(result.state).toBe('EMPANELMENT_ISSUE');
    expect(result.reason).toBe('Vetted by 2 clients, but 0 currently plannable');
  });

  it('never marks an ACTIVE assayer as DEPLOYABLE if critical fields are missing', () => {
    const activeMissingPhone = basePerson({
      lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
      phone: '',
    });

    const result = computeRosterAttention(activeMissingPhone);
    expect(result.state).not.toBe('DEPLOYABLE');
  });

  it('marks an ACTIVE, fully credentialled, plannable assayer as DEPLOYABLE', () => {
    const ready = basePerson({
      lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
      empanelment: {
        clientCount: 3,
        plannableClients: 3,
      },
    } as any);

    const result = computeRosterAttention(ready);
    expect(result.state).toBe('DEPLOYABLE');
    expect(result.reason).toContain('Deployable across 3 client banks');
  });
});

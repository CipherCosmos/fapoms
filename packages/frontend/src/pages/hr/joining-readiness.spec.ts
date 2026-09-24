import { BackgroundCheckVerdict } from '@fapoms/shared';
import { activationBlockers, activationChecklist } from './joining-readiness';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));

/**
 * WHETHER SOMEBODY IS READY TO BE MADE ACTIVE — one rule for the Training step, the approval panel
 * and the approver's review (2026-09-24). What it must never do is let "Approve — make Active" be
 * offered for somebody the server's activation gates will refuse.
 */
describe('ready to be made Active', () => {
  const verified = (requirement: string, label: string) => ({
    requirement, label, identity: true, id: `d-${requirement}`, filePaths: ['scan.jpg'], verificationStatus: 'VERIFIED',
    softCopyReceived: true, hardCopyReceived: false, hardCopyLocation: null, courierReference: null, receivedAt: null,
    documentNumber: null, expiryDate: null, verifiedAt: null, holderName: null, holderDateOfBirth: null,
  });
  const dossier = (over: Record<string, unknown> = {}) => ({
    references: [], empanelments: [], backgroundChecks: [], openIssues: [],
    currentCheck: { id: 'c-1', assayerId: 'a-1', verdict: BackgroundCheckVerdict.CLEAR, createdAt: '2026-09-24' },
    onboarding: [verified('PAN_CARD', 'PAN card'), verified('AADHAAR_FRONT', 'Aadhaar (front)')],
    ...over,
  }) as never;
  const person = (over: Record<string, unknown> = {}) => ({
    id: 'a-1', displayName: 'Shivam Kumar', panNumber: 'ABCDE1234F', bankAccountNumber: '123456789012', ifscCode: 'HDFC0001234',
    latitude: 19.07, longitude: 72.87, phone: '9822014455', email: 'x@y.in', address: 'A', city: 'Pune', state: 'MH', district: 'Pune',
    ...over,
  }) as never;

  it('has nothing in the way for a complete file', () => {
    expect(activationBlockers(person(), dossier())).toEqual([]);
  });

  it('names the bank account and the map pin when they are missing — the server refuses without them', () => {
    const gaps = activationBlockers(person({ bankAccountNumber: null, latitude: null }), dossier());
    expect(gaps).toEqual(expect.arrayContaining(['Bank account number', 'Home location pinned']));
  });

  it('names an identity document that has not been checked against its original', () => {
    const gaps = activationBlockers(person(), dossier({ onboarding: [verified('PAN_CARD', 'PAN card')] }));
    expect(gaps.some((g) => g.startsWith('Aadhaar'))).toBe(true);
  });

  it('will not call somebody ready whose background check came back adverse', () => {
    const gaps = activationBlockers(person(), dossier({ currentCheck: { id: 'c-2', assayerId: 'a-1', verdict: 'CRIMINAL_CASE', createdAt: '2026-09-24' } }));
    expect(gaps.some((g) => /Background check result/.test(g))).toBe(true);
  });

  /** The Training step shows more than it blocks on — "can be done later" — and those must not block. */
  it('lists the rest of the record for information without holding Make Active back on it', () => {
    const items = activationChecklist(person({ email: null }), dossier());
    const info = items.filter((i) => !i.blocking);
    expect(info.length).toBeGreaterThan(0);
    expect(activationBlockers(person({ email: null }), dossier())).toEqual([]);
  });
});

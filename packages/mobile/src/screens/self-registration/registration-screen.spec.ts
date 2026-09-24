import { ApplicationStatus } from '@fapoms/shared';
import { draftPatchForLock, registrationScreenFor } from './registration-screen';

/**
 * WHICH SCREEN THE LINK OPENS ON — the form, where the application stands, or (behind an expired
 * link) what HR asked for. An expired link carries no form data and takes no changes, so the form
 * must never open behind one.
 */
describe('which screen the registration link opens on', () => {
  it('opens the form while it is the candidate\'s to fill in or fix', () => {
    expect(registrationScreenFor(ApplicationStatus.DRAFT, false)).toBe('form');
    expect(registrationScreenFor(ApplicationStatus.AWAITING_INFO, false)).toBe('form');
  });

  it('shows where it stands once it is out of their hands', () => {
    for (const status of [ApplicationStatus.PENDING_VALIDATION, ApplicationStatus.APPROVED, ApplicationStatus.REJECTED, ApplicationStatus.WITHDRAWN]) {
      expect(registrationScreenFor(status, false)).toBe('status');
    }
  });

  it('never opens the form behind an expired link — a sent-back form shows what HR asked for instead', () => {
    expect(registrationScreenFor(ApplicationStatus.AWAITING_INFO, true)).toBe('expired-fix');
    for (const status of [ApplicationStatus.PENDING_VALIDATION, ApplicationStatus.APPROVED, ApplicationStatus.REJECTED, ApplicationStatus.WITHDRAWN]) {
      expect(registrationScreenFor(status, true)).toBe('status');
    }
  });
});

describe('saving while the saved answers are locked', () => {
  it('never sends a blank identity field — blank there means "not shown", not "cleared"', () => {
    expect(draftPatchForLock({ record: { panNumber: '', bankAccountNumber: '  ', city: 'Pune' }, fullName: '' }, true))
      .toEqual({ record: { city: 'Pune' } });
    expect(draftPatchForLock({ record: { panNumber: '' } }, true)).toEqual({});
    expect(draftPatchForLock({ experienceYears: null }, true)).toEqual({});
  });

  it('passes what was actually typed', () => {
    expect(draftPatchForLock({ record: { panNumber: 'ABCDE1234F' }, city: 'Pune' }, true))
      .toEqual({ record: { panNumber: 'ABCDE1234F' }, city: 'Pune' });
  });

  it('leaves an unlocked patch untouched, clears included', () => {
    const patch = { record: { panNumber: '' }, experienceYears: null };
    expect(draftPatchForLock(patch, false)).toBe(patch);
  });
});

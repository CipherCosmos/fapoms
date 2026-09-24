import { ApplicationStatus } from '@fapoms/shared';
import { registrationScreenFor } from './registration-screen';

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

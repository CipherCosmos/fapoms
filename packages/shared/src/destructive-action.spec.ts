import {
  DestructiveActionType,
  DestructiveActionRequestStatus,
  DESTRUCTIVE_APPROVAL_TTL_HOURS,
} from './destructive-action';

/**
 * This file is almost entirely types — the runtime surface is one enum, one status enum, and one
 * constant. But it is the wire vocabulary for the two-person data-wipe rule (a developer requests,
 * an admin approves, only then can the wipe run), so a silently-changed string literal here is a
 * silent protocol break between whatever reads/writes it on the backend and the two screens
 * (Danger Zone, Approvals) that render it. Pinned rather than left unexercised.
 */
describe('DestructiveActionType', () => {
  it('names exactly the one action this covers today', () => {
    expect(DestructiveActionType.DATA_RESET).toBe('DATA_RESET');
  });
});

describe('DestructiveActionRequestStatus', () => {
  it('pins every status string exactly', () => {
    expect(DestructiveActionRequestStatus.REQUESTED).toBe('REQUESTED');
    expect(DestructiveActionRequestStatus.APPROVED).toBe('APPROVED');
    expect(DestructiveActionRequestStatus.REJECTED).toBe('REJECTED');
    expect(DestructiveActionRequestStatus.EXPIRED).toBe('EXPIRED');
    expect(DestructiveActionRequestStatus.CANCELLED).toBe('CANCELLED');
    expect(DestructiveActionRequestStatus.EXECUTED).toBe('EXECUTED');
  });

  it('has no two statuses sharing a string value', () => {
    const values = Object.values(DestructiveActionRequestStatus);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('DESTRUCTIVE_APPROVAL_TTL_HOURS', () => {
  it('is 24 — an approval is for this wipe, now, not a standing grant', () => {
    expect(DESTRUCTIVE_APPROVAL_TTL_HOURS).toBe(24);
  });
});

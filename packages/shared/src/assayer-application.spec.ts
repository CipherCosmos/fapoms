import {
  ApplicationStatus,
  APPLICATION_TERMINAL_STATUSES,
  applicationIsEditableByCandidate,
} from './assayer-application';

describe('applicationIsEditableByCandidate', () => {
  it('is editable while a draft, or while HR has asked for a correction', () => {
    expect(applicationIsEditableByCandidate(ApplicationStatus.DRAFT)).toBe(true);
    expect(applicationIsEditableByCandidate(ApplicationStatus.AWAITING_INFO)).toBe(true);
  });

  it('is not editable once submitted and awaiting review', () => {
    expect(applicationIsEditableByCandidate(ApplicationStatus.PENDING_VALIDATION)).toBe(false);
  });

  it('is not editable in either terminal state', () => {
    expect(applicationIsEditableByCandidate(ApplicationStatus.REJECTED)).toBe(false);
    expect(applicationIsEditableByCandidate(ApplicationStatus.APPROVED)).toBe(false);
  });
});

describe('APPLICATION_TERMINAL_STATUSES', () => {
  it('names exactly REJECTED and APPROVED', () => {
    expect([...APPLICATION_TERMINAL_STATUSES].sort()).toEqual(
      [ApplicationStatus.APPROVED, ApplicationStatus.REJECTED].sort(),
    );
  });

  it('shares no status with the editable-by-candidate set — nothing is both terminal and still editable', () => {
    const editable = Object.values(ApplicationStatus).filter((s) => applicationIsEditableByCandidate(s));
    for (const terminal of APPLICATION_TERMINAL_STATUSES) {
      expect(editable).not.toContain(terminal);
    }
  });

  it('and the editable set together do not cover every status — PENDING_VALIDATION is deliberately neither', () => {
    // Submitted, awaiting HR review: not editable by the candidate, and not a terminal outcome
    // either. Asserted explicitly so a future status addition has to decide which side it falls
    // on, rather than silently landing in this gap by default.
    const editable = Object.values(ApplicationStatus).filter((s) => applicationIsEditableByCandidate(s));
    const accountedFor = new Set([...editable, ...APPLICATION_TERMINAL_STATUSES]);
    expect(accountedFor.has(ApplicationStatus.PENDING_VALIDATION)).toBe(false);
  });
});

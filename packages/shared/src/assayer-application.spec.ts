import { applicationFieldStep,
  ApplicationStatus,
  APPLICATION_TERMINAL_STATUSES,
  APPLICATION_INFO_REQUESTABLE_FIELDS,
  applicationIsEditableByCandidate,
  readApplicationInfoRequests,
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

describe('readApplicationInfoRequests', () => {
  it('reads back well-formed asks', () => {
    expect(readApplicationInfoRequests([
      { kind: 'document', key: 'PAN_CARD', label: 'PAN card', message: 'Retake.' },
      { kind: 'field', key: 'ifscCode', label: 'IFSC code', message: 'Fix it.', reason: null },
    ])).toEqual([
      { kind: 'document', key: 'PAN_CARD', label: 'PAN card', message: 'Retake.', reason: null },
      { kind: 'field', key: 'ifscCode', label: 'IFSC code', message: 'Fix it.', reason: null },
    ]);
  });

  it('drops anything a candidate could not act on, rather than rendering it', () => {
    expect(readApplicationInfoRequests([
      { kind: 'document', key: 'PAN_CARD', label: 'PAN card', message: '  ' },
      { kind: 'carrier-pigeon', key: 'X', label: 'X', message: 'Go.' },
      null,
      'PAN_CARD',
    ])).toEqual([]);
  });

  it('reads an empty list — and a missing column — as no asks', () => {
    expect(readApplicationInfoRequests([])).toEqual([]);
    expect(readApplicationInfoRequests(null)).toEqual([]);
    expect(readApplicationInfoRequests(undefined)).toEqual([]);
  });
});

describe('APPLICATION_INFO_REQUESTABLE_FIELDS', () => {
  it('names every key once, with a human label', () => {
    const keys = APPLICATION_INFO_REQUESTABLE_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const field of APPLICATION_INFO_REQUESTABLE_FIELDS) {
      expect(field.label.trim().length).toBeGreaterThan(0);
      expect(field.label).not.toBe(field.key);
    }
  });
});

describe('applicationFieldStep', () => {
  it('sends a fix to the step each form actually asks for it on', () => {
    expect(applicationFieldStep('fullName')).toBe(1);
    expect(applicationFieldStep('pincode')).toBe(2);
    // The one the web form's private copy got wrong.
    expect(applicationFieldStep('employmentCategory')).toBe(3);
    expect(applicationFieldStep('ifscCode')).toBe(3);
    expect(applicationFieldStep('not-a-field')).toBe(1);
  });

  it('places every field HR can tick on one of the three form steps', () => {
    for (const f of APPLICATION_INFO_REQUESTABLE_FIELDS) expect([1, 2, 3]).toContain(f.step);
  });
});

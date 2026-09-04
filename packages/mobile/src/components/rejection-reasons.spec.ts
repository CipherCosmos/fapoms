import {
  REJECTION_REASON_CATEGORIES,
  REJECTION_REASON_LABELS,
  composeRejectionReason,
  canSubmitRejectionReason,
} from './rejection-reasons';

describe('composeRejectionReason', () => {
  it('sends nothing when nothing has been picked or typed', () => {
    expect(composeRejectionReason(null, '')).toBe('');
  });

  it('falls back to plain typed text when no chip is picked - the original free-text modal, preserved', () => {
    expect(composeRejectionReason(null, 'something typed before picking a chip')).toBe(
      'something typed before picking a chip',
    );
  });

  it.each(Object.keys(REJECTION_REASON_LABELS) as Array<keyof typeof REJECTION_REASON_LABELS>)(
    'sends the preset label alone for %s with no detail typed',
    (category) => {
      expect(composeRejectionReason(category, '')).toBe(REJECTION_REASON_LABELS[category]);
    },
  );

  it('appends typed detail onto a preset label rather than replacing it', () => {
    expect(composeRejectionReason('TOO_FAR', 'branch is 80km away')).toBe(
      'Too far to travel - branch is 80km away',
    );
  });

  it('trims detail before appending it', () => {
    expect(composeRejectionReason('FEE_TOO_LOW', '   too low for the distance   ')).toBe(
      'Fee is too low - too low for the distance',
    );
  });

  it('sends exactly the typed detail for "Other" - no label of its own', () => {
    expect(composeRejectionReason('OTHER', 'my scanner is broken this week')).toBe(
      'my scanner is broken this week',
    );
  });

  it('sends an empty string for "Other" with nothing typed', () => {
    expect(composeRejectionReason('OTHER', '')).toBe('');
  });

  it('every category has a stable, human-readable label', () => {
    for (const category of REJECTION_REASON_CATEGORIES) {
      if (category === 'OTHER') continue;
      expect(REJECTION_REASON_LABELS[category].length).toBeGreaterThan(0);
    }
  });
});

describe('canSubmitRejectionReason', () => {
  it('refuses submission with nothing picked and nothing typed', () => {
    expect(canSubmitRejectionReason(null, '')).toBe(false);
    expect(canSubmitRejectionReason(null, '   ')).toBe(false);
  });

  it('allows plain typed text with no chip picked - the free-text fallback', () => {
    expect(canSubmitRejectionReason(null, 'typed but no chip picked')).toBe(true);
  });

  it('allows a preset category on its own, with no detail required', () => {
    expect(canSubmitRejectionReason('SCHEDULE_CONFLICT', '')).toBe(true);
  });

  it('refuses "Other" with no detail typed - it names nothing on its own', () => {
    expect(canSubmitRejectionReason('OTHER', '')).toBe(false);
    expect(canSubmitRejectionReason('OTHER', '   ')).toBe(false);
  });

  it('allows "Other" once real detail is typed', () => {
    expect(canSubmitRejectionReason('OTHER', 'a real reason')).toBe(true);
  });
});

import { fmtDate, fmtWhen } from './dates';

describe('fmtDate', () => {
  it('formats a bare YYYY-MM-DD date in en-IN style', () => {
    expect(fmtDate('2026-08-18')).toBe('18 Aug 2026');
  });

  it('em-dashes an absent or unparseable date', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
    // The gap a naive `new Date(d).toLocaleDateString(...)` had, and formatDateOnly closes:
    // an Invalid Date still formats, into the literal string "Invalid Date" — not this app's
    // own em-dash convention for "nothing to show".
    expect(fmtDate('not-a-date')).toBe('—');
  });
});

describe('fmtWhen', () => {
  it('formats a date and time in en-IN style', () => {
    expect(fmtWhen('2026-08-18T10:30:00Z')).toMatch(/18 Aug, \d{2}:\d{2}/);
  });

  it('em-dashes an absent date', () => {
    expect(fmtWhen(null)).toBe('—');
    expect(fmtWhen(undefined)).toBe('—');
  });
});

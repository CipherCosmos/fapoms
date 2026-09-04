import { computeSlaClock } from './sla-clock';

describe('computeSlaClock', () => {
  const start = new Date('2026-09-01T00:00:00.000Z');

  it('sets the deadline at start + SLA days and counts down', () => {
    const c = computeSlaClock(start, 30, null, new Date('2026-09-11T00:00:00.000Z')); // 10 days in
    expect(c.dueAt).toBe('2026-10-01T00:00:00.000Z');
    expect(c.daysRemaining).toBe(20);
    expect(c.overdue).toBe(false);
  });

  it('flags overdue past the deadline when unresolved', () => {
    const c = computeSlaClock(start, 30, null, new Date('2026-10-05T00:00:00.000Z'));
    expect(c.overdue).toBe(true);
    expect(c.daysRemaining).toBeLessThan(0);
  });

  it('clears once satisfied, however late', () => {
    const c = computeSlaClock(start, 30, new Date('2026-10-05T00:00:00.000Z'), new Date('2026-10-06T00:00:00.000Z'));
    expect(c.satisfied).toBe(true);
    expect(c.overdue).toBe(false);
    expect(c.daysRemaining).toBeNull();
  });
});

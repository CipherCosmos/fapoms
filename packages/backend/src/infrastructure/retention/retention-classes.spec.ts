import { resolveRetention, RETENTION_POLICIES } from './retention-classes';

/**
 * The one property that must hold for a bank vendor: a configured retention can go LONGER than the
 * law, never shorter. These pin the floor-clamp, the two "keep indefinitely" escape hatches, and
 * that a garbage value falls back to the default rather than being trusted.
 */
describe('resolveRetention', () => {
  it('raises a value below the statutory floor up to the floor', () => {
    // SESSION_HISTORY floor is 180 (CERT-In). 30 is below it.
    expect(resolveRetention('SESSION_HISTORY', 30)).toEqual({ days: 180, clampedToFloor: true });
    // ACCESS_LOG / AUDIT_TRAIL floor is 365 (DPDP).
    expect(resolveRetention('ACCESS_LOG', 100)).toEqual({ days: 365, clampedToFloor: true });
  });

  it('keeps a value at or above the floor as configured', () => {
    expect(resolveRetention('SESSION_HISTORY', 400)).toEqual({ days: 400, clampedToFloor: false });
    expect(resolveRetention('AUDIT_TRAIL', 2555)).toEqual({ days: 2555, clampedToFloor: false }); // 7y
  });

  it('treats an unset value as the class default', () => {
    expect(resolveRetention('SESSION_HISTORY', null).days).toBe(RETENTION_POLICIES.SESSION_HISTORY.defaultDays);
    expect(resolveRetention('UI_TELEMETRY', undefined).days).toBe(180);
  });

  it('treats an explicit 0 as "keep indefinitely", not "delete everything"', () => {
    expect(resolveRetention('SESSION_HISTORY', 0)).toEqual({ days: 0, clampedToFloor: false });
  });

  it('falls back to the default for a negative or non-numeric value rather than trusting it', () => {
    expect(resolveRetention('SESSION_HISTORY', -5).days).toBeNull();
    expect(resolveRetention('SESSION_HISTORY', NaN).days).toBeNull();
  });

  it('never lets any class resolve below its own floor for a positive input', () => {
    for (const [cls, policy] of Object.entries(RETENTION_POLICIES)) {
      if (policy.floorDays === null) continue;
      const r = resolveRetention(cls as any, 1);
      expect(r.days).toBe(policy.floorDays);
    }
  });
});

import { computeIncidentClocks } from './incident-clocks';

/**
 * The deadline arithmetic a bank vendor is judged on: CERT-In's 6-hour cyber-incident report and
 * DPDP's 72-hour data-principal notification, both counted from detection. These pin the four
 * states that matter — plenty of time, running down, overdue, and satisfied — for each clock, plus
 * the rule that the DPDP clock only exists when personal data was involved.
 */
describe('computeIncidentClocks', () => {
  const detectedAt = new Date('2026-09-04T00:00:00.000Z');
  const base = { detectedAt, personalDataInvolved: false, certInReportedAt: null, principalsNotifiedAt: null };

  it('starts the CERT-In clock at detection + 6 hours', () => {
    const now = new Date('2026-09-04T02:00:00.000Z'); // 2h in → 4h left
    const { certIn } = computeIncidentClocks(base, now);
    expect(certIn.applicable).toBe(true);
    expect(certIn.dueAt).toBe('2026-09-04T06:00:00.000Z');
    expect(certIn.hoursRemaining).toBe(4);
    expect(certIn.overdue).toBe(false);
    expect(certIn.satisfied).toBe(false);
  });

  it('marks CERT-In overdue once past 6 hours with no report filed', () => {
    const now = new Date('2026-09-04T07:00:00.000Z'); // 1h past deadline
    const { certIn } = computeIncidentClocks(base, now);
    expect(certIn.overdue).toBe(true);
    expect(certIn.hoursRemaining).toBeLessThan(0);
  });

  it('clears the CERT-In clock once the report is filed, even if late', () => {
    const now = new Date('2026-09-04T07:00:00.000Z');
    const reported = { ...base, certInReportedAt: new Date('2026-09-04T05:00:00.000Z') };
    const { certIn } = computeIncidentClocks(reported, now);
    expect(certIn.satisfied).toBe(true);
    expect(certIn.overdue).toBe(false);
    expect(certIn.hoursRemaining).toBeNull();
  });

  it('does not run the DPDP principal clock when no personal data was involved', () => {
    const now = new Date('2026-09-08T00:00:00.000Z'); // days later
    const { dpdpPrincipals } = computeIncidentClocks(base, now);
    expect(dpdpPrincipals.applicable).toBe(false);
    expect(dpdpPrincipals.overdue).toBe(false);
    expect(dpdpPrincipals.dueAt).toBeNull();
  });

  it('runs the DPDP clock at detection + 72 hours for a personal-data breach', () => {
    const pd = { ...base, personalDataInvolved: true };
    const inWindow = computeIncidentClocks(pd, new Date('2026-09-05T00:00:00.000Z')); // 24h in
    expect(inWindow.dpdpPrincipals.applicable).toBe(true);
    expect(inWindow.dpdpPrincipals.dueAt).toBe('2026-09-07T00:00:00.000Z');
    expect(inWindow.dpdpPrincipals.overdue).toBe(false);

    const late = computeIncidentClocks(pd, new Date('2026-09-08T00:00:00.000Z')); // past 72h
    expect(late.dpdpPrincipals.overdue).toBe(true);

    const notified = computeIncidentClocks(
      { ...pd, principalsNotifiedAt: new Date('2026-09-06T00:00:00.000Z') },
      new Date('2026-09-08T00:00:00.000Z'),
    );
    expect(notified.dpdpPrincipals.satisfied).toBe(true);
    expect(notified.dpdpPrincipals.overdue).toBe(false);
  });
});

import { computeIncidentClocks } from './incident-clocks';

/**
 * The deadline arithmetic a bank vendor is judged on: CERT-In's 6-hour cyber-incident report, DPDP's
 * 72-hour Board breach-report, and DPDP's Data-Principal notification — which the rule gives no fixed
 * hour count at all ("without delay"). These pin the states that matter for each clock, plus the rule
 * that the two DPDP clocks only exist when personal data was involved, and that only one of them
 * ("dpdpBoard") is legitimately a 72-hour countdown.
 *
 * This file previously asserted the 72-hour figure against `dpdpPrincipals` — that was itself the bug
 * (DPDP Rule 7 puts the 72-hour report on the Board, not on notifying Data Principals, who must be
 * told "without delay" with no fixed hour count at all). See incident-clocks.ts's own comment.
 */
describe('computeIncidentClocks', () => {
  const detectedAt = new Date('2026-09-04T00:00:00.000Z');
  const base = {
    detectedAt, personalDataInvolved: false,
    certInReportedAt: null, boardNotifiedAt: null, principalsNotifiedAt: null,
  };

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

  it('does not run either DPDP clock when no personal data was involved', () => {
    const now = new Date('2026-09-08T00:00:00.000Z'); // days later
    const { dpdpBoard, dpdpPrincipals } = computeIncidentClocks(base, now);
    expect(dpdpBoard.applicable).toBe(false);
    expect(dpdpBoard.overdue).toBe(false);
    expect(dpdpBoard.dueAt).toBeNull();
    expect(dpdpPrincipals.applicable).toBe(false);
    expect(dpdpPrincipals.overdue).toBe(false);
    expect(dpdpPrincipals.dueAt).toBeNull();
  });

  describe('dpdpBoard — the real 72-hour clock (Board breach report)', () => {
    it('runs at detection + 72 hours for a personal-data breach', () => {
      const pd = { ...base, personalDataInvolved: true };
      const inWindow = computeIncidentClocks(pd, new Date('2026-09-05T00:00:00.000Z')); // 24h in
      expect(inWindow.dpdpBoard.applicable).toBe(true);
      expect(inWindow.dpdpBoard.dueAt).toBe('2026-09-07T00:00:00.000Z');
      expect(inWindow.dpdpBoard.overdue).toBe(false);

      const late = computeIncidentClocks(pd, new Date('2026-09-08T00:00:00.000Z')); // past 72h
      expect(late.dpdpBoard.overdue).toBe(true);

      const notified = computeIncidentClocks(
        { ...pd, boardNotifiedAt: new Date('2026-09-06T00:00:00.000Z') },
        new Date('2026-09-08T00:00:00.000Z'),
      );
      expect(notified.dpdpBoard.satisfied).toBe(true);
      expect(notified.dpdpBoard.overdue).toBe(false);
    });

    it('is independent of whether Data Principals have been notified', () => {
      const pd = { ...base, personalDataInvolved: true, principalsNotifiedAt: new Date('2026-09-04T01:00:00.000Z') };
      const { dpdpBoard } = computeIncidentClocks(pd, new Date('2026-09-08T00:00:00.000Z'));
      expect(dpdpBoard.satisfied).toBe(false);
      expect(dpdpBoard.overdue).toBe(true); // still overdue on ITS OWN milestone, boardNotifiedAt
    });
  });

  describe('dpdpPrincipals — "without delay", no fixed hour count', () => {
    it('never carries a dueAt or hoursRemaining, applicable or not', () => {
      const pd = { ...base, personalDataInvolved: true };
      const { dpdpPrincipals } = computeIncidentClocks(pd, new Date('2026-09-04T00:00:01.000Z'));
      expect(dpdpPrincipals.applicable).toBe(true);
      expect(dpdpPrincipals.dueAt).toBeNull();
      expect(dpdpPrincipals.hoursRemaining).toBeNull();
    });

    it('reflects satisfied once principals are notified, however late', () => {
      const pd = { ...base, personalDataInvolved: true, principalsNotifiedAt: new Date('2026-09-06T00:00:00.000Z') };
      const { dpdpPrincipals } = computeIncidentClocks(pd, new Date('2026-09-08T00:00:00.000Z'));
      expect(dpdpPrincipals.satisfied).toBe(true);
      expect(dpdpPrincipals.overdue).toBe(false);
    });

    it('does NOT set overdue even long after detection — the rule sets no instant to be "past"', () => {
      // This is deliberate, not a gap: badging this OVERDUE would itself assert a deadline the law
      // does not set. `applicable && !satisfied` is the honest, unstarred signal to build alerts on.
      const pd = { ...base, personalDataInvolved: true };
      const { dpdpPrincipals } = computeIncidentClocks(pd, new Date('2026-09-20T00:00:00.000Z')); // 16 days later
      expect(dpdpPrincipals.satisfied).toBe(false);
      expect(dpdpPrincipals.overdue).toBe(false);
    });
  });
});

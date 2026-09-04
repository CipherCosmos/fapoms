import { BadRequestException } from '@nestjs/common';
import { SecurityIncidentService } from './security-incident.service';

describe('SecurityIncidentService', () => {
  let repo: any;
  let audit: any;
  let notificationDispatch: any;
  let service: SecurityIncidentService;

  beforeEach(() => {
    const store = new Map<string, any>();
    repo = {
      create: jest.fn((d: any) => ({ ...d })),
      save: jest.fn(async (d: any) => { const row = { id: d.id ?? 'inc-1', ...d }; store.set(row.id, row); return row; }),
      findOne: jest.fn(async ({ where: { id } }: any) => store.get(id) ?? null),
      find: jest.fn(async () => [...store.values()]),
    };
    audit = { recordEventSafe: jest.fn().mockResolvedValue(undefined) };
    notificationDispatch = { emitSafe: jest.fn() };
    service = new SecurityIncidentService(repo, audit, notificationDispatch);
  });

  it('raises an incident, audits it, notifies, and returns it with live clocks', async () => {
    const view = await service.create(
      { title: 'Suspicious admin login', category: 'UNAUTHORISED_ACCESS', severity: 'HIGH', personalDataInvolved: true },
      'admin-1',
    );
    expect(view.status).toBe('OPEN');
    expect(view.clocks.certIn.applicable).toBe(true);
    expect(view.clocks.dpdpPrincipals.applicable).toBe(true); // personal data → DPDP clock on
    expect(audit.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'SECURITY_INCIDENT_RAISED', entityType: 'SECURITY_INCIDENT' }),
    );
    // A raised incident must reach somebody, not just the audit trail — see notification-catalog.ts.
    expect(notificationDispatch.emitSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SECURITY_INCIDENT_RAISED',
        entityId: view.id,
        actorUserId: 'admin-1',
        payload: expect.objectContaining({ severity: 'HIGH', category: 'UNAUTHORISED_ACCESS' }),
      }),
    );
  });

  it('rejects an unknown category or severity', async () => {
    await expect(service.create({ title: 'x', category: 'NOPE', severity: 'HIGH' }, null))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({ title: 'x', category: 'MALWARE', severity: 'SEVERE' }, null))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('records reporting milestones with a timestamp and audits the change', async () => {
    const created = await service.create({ title: 'Breach', category: 'DATA_BREACH', severity: 'CRITICAL', personalDataInvolved: true }, 'a');
    const updated = await service.update(created.id, { markCertInReported: true, markPrincipalsNotified: true }, 'a');

    expect(updated.certInReportedAt).toBeInstanceOf(Date);
    expect(updated.principalsNotifiedAt).toBeInstanceOf(Date);
    // Both milestones now satisfied → not overdue however much time passes.
    expect(updated.clocks.certIn.satisfied).toBe(true);
    expect(updated.clocks.dpdpPrincipals.satisfied).toBe(true);
    // The Board milestone is separate and was never marked — its own 72h clock is still running.
    // (falsy, not strictly toBeNull(): this suite's hand-rolled repo mock doesn't simulate TypeORM's
    // nullable-column defaults the way the real, Postgres-backed row does — confirmed live that the
    // real API returns an explicit `null` here, not `undefined`.)
    expect(updated.boardNotifiedAt).toBeFalsy();
    expect(updated.clocks.dpdpBoard.applicable).toBe(true);
    expect(updated.clocks.dpdpBoard.satisfied).toBe(false);
    expect(audit.recordEventSafe).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventType: 'SECURITY_INCIDENT_UPDATED' }),
    );
  });

  it('records the Board-notified milestone independently and satisfies its own 72h clock', async () => {
    const created = await service.create({ title: 'Breach', category: 'DATA_BREACH', severity: 'CRITICAL', personalDataInvolved: true }, 'a');
    const updated = await service.update(created.id, { markBoardNotified: true }, 'a');

    expect(updated.boardNotifiedAt).toBeInstanceOf(Date);
    expect(updated.clocks.dpdpBoard.satisfied).toBe(true);
    expect(updated.clocks.dpdpBoard.overdue).toBe(false);
    // Marking the Board notified does not itself notify Data Principals — separate obligation, separate milestone.
    expect(updated.principalsNotifiedAt).toBeFalsy();
    expect(updated.clocks.dpdpPrincipals.satisfied).toBe(false);
  });

  it('stamps resolvedAt when moved to RESOLVED', async () => {
    const created = await service.create({ title: 'x', category: 'OTHER', severity: 'LOW' }, 'a');
    const updated = await service.update(created.id, { status: 'RESOLVED' }, 'a');
    expect(updated.resolvedAt).toBeInstanceOf(Date);
  });

  it('summarises open and clock-overdue incidents, including the Board clock', async () => {
    // One old, unreported personal-data breach → CERT-In and Board both genuinely overdue (both carry
    // a fixed hour count), and principals still un-notified (counted, though "overdue" isn't the
    // legally accurate word for that one — see incident-clocks.ts).
    await service.create(
      { title: 'old', category: 'DATA_BREACH', severity: 'HIGH', personalDataInvolved: true, detectedAt: '2026-01-01T00:00:00.000Z' },
      'a',
    );
    const summary = await service.summary();
    expect(summary.open).toBe(1);
    expect(summary.certInOverdue).toBe(1);
    expect(summary.boardOverdue).toBe(1);
    expect(summary.principalsOverdue).toBe(1);
  });

  it('does not count the Board clock against a non-personal-data incident', async () => {
    await service.create(
      { title: 'old, no personal data', category: 'MALWARE', severity: 'HIGH', detectedAt: '2026-01-01T00:00:00.000Z' },
      'a',
    );
    const summary = await service.summary();
    expect(summary.certInOverdue).toBe(1); // CERT-In always applies
    expect(summary.boardOverdue).toBe(0); // DPDP does not
    expect(summary.principalsOverdue).toBe(0);
  });
});

import { BadRequestException } from '@nestjs/common';
import { SecurityIncidentService } from './security-incident.service';

describe('SecurityIncidentService', () => {
  let repo: any;
  let audit: any;
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
    service = new SecurityIncidentService(repo, audit);
  });

  it('raises an incident, audits it, and returns it with live clocks', async () => {
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
    // Both clocks now satisfied → not overdue however much time passes.
    expect(updated.clocks.certIn.satisfied).toBe(true);
    expect(updated.clocks.dpdpPrincipals.satisfied).toBe(true);
    expect(audit.recordEventSafe).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventType: 'SECURITY_INCIDENT_UPDATED' }),
    );
  });

  it('stamps resolvedAt when moved to RESOLVED', async () => {
    const created = await service.create({ title: 'x', category: 'OTHER', severity: 'LOW' }, 'a');
    const updated = await service.update(created.id, { status: 'RESOLVED' }, 'a');
    expect(updated.resolvedAt).toBeInstanceOf(Date);
  });

  it('summarises open and clock-overdue incidents', async () => {
    // One old, unreported personal-data breach → both clocks overdue and still open.
    await service.create(
      { title: 'old', category: 'DATA_BREACH', severity: 'HIGH', personalDataInvolved: true, detectedAt: '2026-01-01T00:00:00.000Z' },
      'a',
    );
    const summary = await service.summary();
    expect(summary.open).toBe(1);
    expect(summary.certInOverdue).toBe(1);
    expect(summary.principalsOverdue).toBe(1);
  });
});

import { BadRequestException } from '@nestjs/common';
import { DataRightsRequestService } from './data-rights-request.service';

describe('DataRightsRequestService', () => {
  let repo: any;
  let audit: any;
  let settings: any;
  let service: DataRightsRequestService;

  beforeEach(() => {
    const store = new Map<string, any>();
    repo = {
      create: jest.fn((d: any) => ({ ...d })),
      save: jest.fn(async (d: any) => { const row = { id: d.id ?? 'req-1', ...d }; store.set(row.id, row); return row; }),
      findOne: jest.fn(async ({ where: { id } }: any) => store.get(id) ?? null),
      find: jest.fn(async () => [...store.values()]),
    };
    audit = { recordEventSafe: jest.fn().mockResolvedValue(undefined) };
    settings = { get: jest.fn().mockResolvedValue(null) }; // → default 30-day SLA
    service = new DataRightsRequestService(repo, audit, settings);
  });

  it('logs a rights request with the default 30-day SLA and audits it', async () => {
    const view = await service.create({ requestType: 'ERASURE', subjectRef: 'ASY-0001' }, 'admin-1');
    expect(view.status).toBe('RECEIVED');
    // Received now → due ~30 days out, not overdue.
    expect(view.sla.overdue).toBe(false);
    expect(view.sla.daysRemaining).toBeGreaterThan(29);
    expect(audit.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'DATA_RIGHTS_REQUEST_RECEIVED', entityType: 'DATA_RIGHTS_REQUEST' }),
    );
  });

  it('rejects an unknown request type', async () => {
    await expect(service.create({ requestType: 'SELL_MY_DATA' }, null)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('honours a configured SLA from settings', async () => {
    settings.get.mockResolvedValue(7);
    const view = await service.create({ requestType: 'ACCESS' }, 'a');
    expect(view.sla.daysRemaining).toBeLessThanOrEqual(7);
  });

  it('stamps completion and records a legal-retention hold on erasure', async () => {
    const created = await service.create({ requestType: 'ERASURE' }, 'a');
    const updated = await service.update(created.id, { status: 'COMPLETED', legalHoldApplied: true, resolutionNotes: 'Kept audit evidence per RBI retention.' }, 'a');
    expect(updated.completedAt).toBeInstanceOf(Date);
    expect(updated.legalHoldApplied).toBe(true);
    expect(updated.sla.satisfied).toBe(true);
    expect(audit.recordEventSafe).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventType: 'DATA_RIGHTS_REQUEST_UPDATED', remarks: 'legal-retention hold applied' }),
    );
  });

  it('summarises open and overdue requests', async () => {
    // An old, unresolved request → overdue on the 30-day SLA.
    repo.save({ id: 'old', requestType: 'GRIEVANCE', status: 'RECEIVED', receivedAt: new Date('2026-01-01T00:00:00.000Z'), completedAt: null });
    const summary = await service.summary();
    expect(summary.open).toBe(1);
    expect(summary.overdue).toBe(1);
  });
});

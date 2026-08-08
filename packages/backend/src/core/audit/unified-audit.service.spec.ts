import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UnifiedAuditService } from './unified-audit.service';

/**
 * The guarantee under test is a compliance one: for any entity, the trail must include every
 * table this system writes history to. `/audit-log/entity` reads only `audit_events`, which on
 * live data was 73 of 117 events — an auditor was silently shown 62% of the record.
 */
describe('UnifiedAuditService', () => {
  let service: UnifiedAuditService;
  let query: jest.Mock;

  beforeEach(async () => {
    query = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UnifiedAuditService,
        { provide: getDataSourceToken(), useValue: { query } as Partial<DataSource> },
      ],
    }).compile();
    service = module.get(UnifiedAuditService);
  });

  /** Queries run in a fixed order: general, workflow, assayer, billing. */
  const respond = (general: any[], workflow: any[], assayer: any[], billing: any[]) => {
    query
      .mockResolvedValueOnce(general)
      .mockResolvedValueOnce(workflow)
      .mockResolvedValueOnce(assayer)
      .mockResolvedValueOnce(billing);
  };

  it('draws from every history table, not just audit_events', async () => {
    respond(
      [{ event_type: 'ASSAYER_UPDATED', occurred_at: '2026-08-01T10:00:00Z' }],
      [{ command: 'StartPlanningCommand', timestamp: '2026-08-02T10:00:00Z' }],
      [{ event_type: 'LIFECYCLE_TRANSITION', occurred_at: '2026-08-03T10:00:00Z' }],
      [{ action: 'PAYABLE_DISBURSED', created_at: '2026-08-04T10:00:00Z' }],
    );

    const { entries, countsBySource } = await service.getTrail('e-1');

    expect(entries).toHaveLength(4);
    expect(countsBySource).toEqual({
      audit_events: 1, workflow_history: 1, assayer_activities: 1, billing_history: 1,
    });
  });

  it('orders the merged trail newest first, across sources', async () => {
    respond(
      [{ event_type: 'OLDEST', occurred_at: '2026-08-01T00:00:00Z' }],
      [{ command: 'NEWEST', timestamp: '2026-08-09T00:00:00Z' }],
      [{ event_type: 'MIDDLE', occurred_at: '2026-08-05T00:00:00Z' }],
      [],
    );

    const { entries } = await service.getTrail('e-1');
    expect(entries.map((e) => e.eventType)).toEqual(['NEWEST', 'MIDDLE', 'OLDEST']);
  });

  it('keeps the money detail billing_history carries, rather than flattening it away', async () => {
    respond([], [], [], [{
      action: 'ENTRY_ADJUSTED',
      created_at: '2026-08-04T10:00:00Z',
      previous_value: { amount: 1200 },
      new_value: { amount: 1500 },
      client_id: 'c-1',
      reason: 'Rate card correction',
    }]);

    const { entries } = await service.getTrail('e-1');
    expect(entries[0].metadata).toMatchObject({
      previousValue: { amount: 1200 },
      newValue: { amount: 1500 },
      clientId: 'c-1',
    });
    expect(entries[0].remarks).toBe('Rate card correction');
  });

  it('still returns the other trails when one query fails', async () => {
    // A broken or missing table must not blank the whole trail — partial evidence with the
    // sources named beats an empty page that looks like "nothing happened".
    query
      .mockRejectedValueOnce(new Error('relation missing'))
      .mockResolvedValueOnce([{ command: 'AuditScheduled', timestamp: '2026-08-02T10:00:00Z' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const { entries, countsBySource } = await service.getTrail('e-1');
    expect(entries).toHaveLength(1);
    expect(countsBySource).toEqual({ workflow_history: 1 });
  });

  it('passes entityType as a bound parameter, never interpolated into SQL', async () => {
    respond([], [], [], []);
    await service.getTrail('e-1', "ASSAYER'; DROP TABLE audit_events;--");

    for (const [sql, params] of query.mock.calls) {
      expect(sql).not.toContain('DROP TABLE');
      expect(Array.isArray(params)).toBe(true);
    }
  });
});

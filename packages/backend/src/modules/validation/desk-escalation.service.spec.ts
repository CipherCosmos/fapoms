import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DeskEscalationService } from './desk-escalation.service';
import { ValidationCaseEntity } from './validation-case.entity';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

/**
 * The head's exception buckets, and the escalation that runs off them.
 *
 * Two things were wrong and both were invisible: the screen reported the query's row cap as if
 * it were the size of the backlog, and the notification scan walked that same capped list — so
 * on a genuinely backed-up desk the oldest fifty were re-notified every fifteen minutes while
 * the fifty-first was never escalated to anybody.
 */
describe('DeskEscalationService', () => {
  let service: DeskEscalationService;
  let emitSafe: jest.Mock;
  /** Every SQL string the service issued, in order. */
  let sql: string[];
  /** Rows the next query returns, keyed by which bucket asked. */
  let rowsFor: (query: string) => any[];

  const row = (id: string, total: number) => ({
    id,
    projectBranchId: `pb-${id}`,
    branchName: `Branch ${id}`,
    ageHours: 30,
    who: null,
    whoId: null,
    totalMatching: String(total),
  });

  beforeEach(async () => {
    sql = [];
    rowsFor = () => [];
    emitSafe = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeskEscalationService,
        {
          provide: getRepositoryToken(ValidationCaseEntity),
          useValue: { manager: { query: jest.fn(async (q: string) => { sql.push(q); return rowsFor(q); }) } },
        },
        { provide: NotificationDispatchService, useValue: { emitSafe } },
      ],
    }).compile();

    service = module.get(DeskEscalationService);
  });

  describe('attention', () => {
    it('reports the true breach count, not the number of rows it returned', async () => {
      // The desk has 412 unassigned packets in breach; the query returns the first 50.
      rowsFor = (q) => (q.includes('d.assigned_to_user_id IS NULL')
        ? Array.from({ length: 50 }, (_, i) => row(`u${i}`, 412))
        : []);

      const a = await service.attention();

      expect(a.unassignedOverdue.items).toHaveLength(50);
      expect(a.unassignedOverdue.total).toBe(412);
    });

    it('caps the rows it ships for the screen', async () => {
      await service.attention();
      // The row cap is the trailing LIMIT on each bucket. (One query also has a `LIMIT 1`
      // inside a correlated subquery — that is not the cap and must not be matched.)
      expect(sql.every((q) => /LIMIT \d+\s*$/.test(q.trim()))).toBe(true);
    });

    it('reports an empty bucket as zero rather than guessing', async () => {
      const a = await service.attention();
      expect(a.ocrStuck).toEqual({ items: [], total: 0 });
    });

    it('strips the count column out of the items it returns', async () => {
      rowsFor = (q) => (q.includes('d.assigned_to_user_id IS NULL') ? [row('u1', 7)] : []);
      const a = await service.attention();
      expect(a.unassignedOverdue.items[0]).not.toHaveProperty('totalMatching');
      expect(a.unassignedOverdue.items[0]).toMatchObject({ id: 'u1', branchName: 'Branch u1' });
    });
  });

  describe('scan', () => {
    it('escalates every breach, not just the screenful', async () => {
      // 120 in breach. The scan must not inherit the screen's cap: item 51 was previously
      // never notified at all until one of the fifty ahead of it cleared.
      rowsFor = (q) => (q.includes('d.assigned_to_user_id IS NULL')
        ? Array.from({ length: 120 }, (_, i) => row(`u${i}`, 120))
        : []);

      const emitted = await service.scan();

      expect(emitted).toBe(120);
      expect(emitSafe).toHaveBeenCalledTimes(120);
    });

    it('asks for every row when scanning, and only then', async () => {
      const trailingLimit = (q: string) => /LIMIT \d+\s*$/.test(q.trim());

      await service.scan();
      expect(sql.some(trailingLimit)).toBe(false);

      sql = [];
      await service.attention();
      expect(sql.every(trailingLimit)).toBe(true);
    });

    it('keys each notification to the item and the day, so a persistent breach is one reminder', async () => {
      rowsFor = (q) => (q.includes('d.assigned_to_user_id IS NULL') ? [row('u1', 1)] : []);
      await service.scan();

      const key = emitSafe.mock.calls[0][0].dedupeKey as string;
      expect(key).toMatch(/^DESK_PACKET_UNASSIGNED_SLA:u1:\d{4}-\d{2}-\d{2}$/);
    });
  });
});

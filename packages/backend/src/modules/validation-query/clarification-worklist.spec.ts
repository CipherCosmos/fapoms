import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ValidationQueryService } from './validation-query.service';
import { ValidationQueryEntity } from './validation-query.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationService } from '../notifications/notification.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { QueryThreadService } from './query-thread.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { Region } from '@fapoms/shared';

/**
 * The clarification worklist, as a query rather than a download.
 *
 * `validation_queries` is append-only and never pruned: every question ever asked, resolved
 * ones included, stays in it forever. The page showed one tab at a time but fetched all of
 * them and did the filtering and the tab counts in the browser — a request that grows without
 * limit for a screen that renders a hundred rows. These pin that the tab decides the SQL, the
 * page is capped, and the counts still describe the whole worklist rather than the cap.
 */
describe('ValidationQueryService.getClarificationWorklist', () => {
  let service: ValidationQueryService;
  const query = jest.fn();
  const mockRegionGuard = { stagedMode: jest.fn().mockResolvedValue('off') };

  /** The SQL of the call that selected rows, as opposed to the one that counted them. */
  const rowSql = () => String(query.mock.calls.find((c) => !String(c[0]).includes('COUNT(*)'))?.[0] ?? '');

  beforeEach(async () => {
    query.mockReset();
    mockRegionGuard.stagedMode.mockReset().mockResolvedValue('off');
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('COUNT(*)')) {
        return [{ total: 812, us: 14, assayer: 26, done: 772, overdue: 9 }];
      }
      return [
        { id: 'q-1', status: 'RESPONDED', queryText: 'Which vault?', slaDueDate: '2020-01-01T00:00:00Z' },
        { id: 'q-2', status: 'OPEN', queryText: 'Photo unclear', slaDueDate: null },
        { id: 'q-3', status: 'RESOLVED', queryText: 'Closed', slaDueDate: null },
      ];
    });

    const noop = {};
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidationQueryService,
        { provide: getRepositoryToken(ValidationQueryEntity), useValue: { manager: { query } } },
        { provide: getRepositoryToken(ValidationCaseEntity), useValue: noop },
        { provide: getRepositoryToken(AssignmentEntity), useValue: noop },
        { provide: AuditService, useValue: noop },
        { provide: DomainEventPublisher, useValue: noop },
        { provide: NotificationService, useValue: noop },
        { provide: PushNotificationService, useValue: noop },
        { provide: QueryThreadService, useValue: noop },
        { provide: NotificationDispatchService, useValue: noop },
        { provide: RegionGuardService, useValue: mockRegionGuard },
      ],
    }).compile();
    service = module.get(ValidationQueryService);
  });

  it('caps the rows it returns rather than sending every clarification ever raised', async () => {
    await service.getClarificationWorklist();
    expect(rowSql()).toContain('LIMIT');
  });

  it('refuses a caller-supplied limit large enough to be the old behaviour', async () => {
    const res = await service.getClarificationWorklist({ limit: 100000 });
    expect(res.limit).toBeLessThanOrEqual(200);
    expect(rowSql()).toContain(`LIMIT ${res.limit}`);
  });

  it('filters by tab in SQL, so a tab loads its own rows and not all of them', async () => {
    await service.getClarificationWorklist({ filter: 'US' });
    expect(rowSql()).toContain("= 'US'");

    query.mockClear();
    await service.getClarificationWorklist({ filter: 'OVERDUE' });
    expect(rowSql()).toContain('sla_due_date < NOW()');
  });

  it('leaves the row query unfiltered on the ALL tab', async () => {
    await service.getClarificationWorklist({ filter: 'ALL' });
    expect(rowSql()).not.toContain("= 'US'");
    expect(rowSql()).not.toContain("= 'ASSAYER'");
  });

  it('counts the whole worklist, not the rows that came back', async () => {
    const res = await service.getClarificationWorklist({ filter: 'US' });

    // Three rows in hand; eight hundred behind them. The tabs must show the latter.
    expect(res.items).toHaveLength(3);
    expect(res.counts).toEqual({ US: 14, ASSAYER: 26, DONE: 772, OVERDUE: 9, total: 812 });
  });

  it('says whose court each clarification is in, which the status alone did not', async () => {
    const res = await service.getClarificationWorklist();
    expect(res.items.map((i) => i.awaiting)).toEqual(['US', 'ASSAYER', 'DONE']);
    // A deadline in 2020 on an unresolved query is overdue; a resolved one never is.
    expect(res.items[0].slaOverdue).toBe(true);
    expect(res.items[2].slaOverdue).toBe(false);
  });

  /**
   * The worklist previously had zero region scoping: a region-restricted account saw every
   * region's clarifications and tab counts through it. `RegionGuardService.stagedMode()` gates
   * the rollout — `off`/`log` must leave today's response untouched, and `enforce` must actually
   * narrow both the rows and the tab counts.
   */
  describe('region scoping (staged)', () => {
    const regions = [Region.NORTH];

    it('never reads the setting for an unrestricted caller', async () => {
      await service.getClarificationWorklist({ scope: { regions: null } });
      expect(mockRegionGuard.stagedMode).not.toHaveBeenCalled();
    });

    it('off mode leaves the SQL and the response byte-for-byte identical to an unscoped call', async () => {
      mockRegionGuard.stagedMode.mockResolvedValue('off');

      const unscoped = await service.getClarificationWorklist();
      const unscopedRowSql = rowSql();
      query.mockClear();

      const scoped = await service.getClarificationWorklist({ scope: { regions } });

      expect(mockRegionGuard.stagedMode).toHaveBeenCalled();
      expect(rowSql()).toBe(unscopedRowSql);
      expect(rowSql()).not.toContain('region');
      expect(scoped).toEqual(unscoped);
    });

    it('log mode returns the identical unfiltered response and logs what it would have filtered', async () => {
      mockRegionGuard.stagedMode.mockResolvedValue('log');
      query.mockReset();
      query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('COUNT(*)')) {
          return [{ total: 812, us: 14, assayer: 26, done: 772, overdue: 9 }];
        }
        return [
          { id: 'q-1', status: 'RESPONDED', queryText: 'Which vault?', slaDueDate: '2020-01-01T00:00:00Z', regionGate: 'SOUTH' },
          { id: 'q-2', status: 'OPEN', queryText: 'Photo unclear', slaDueDate: null, regionGate: 'NORTH' },
          { id: 'q-3', status: 'RESOLVED', queryText: 'Closed', slaDueDate: null, regionGate: null },
        ];
      });
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      const res = await service.getClarificationWorklist({ scope: { regions } });

      // Unfiltered: all three rows still come back, and `regionGate` never leaks into an item.
      expect(res.items).toHaveLength(3);
      expect(res.items.every((i: any) => !('regionGate' in i))).toBe(true);
      expect(res.counts).toEqual({ US: 14, ASSAYER: 26, DONE: 772, OVERDUE: 9, total: 812 });
      // q-1 (SOUTH) is outside [NORTH]; q-3's unresolvable (null) region never counts.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('would filter 1/3 rows'));
      // Exactly the two calls this route always makes (counts, rows) — no extra query for the log line.
      expect(query).toHaveBeenCalledTimes(2);
      warnSpy.mockRestore();
    });

    it('enforce mode filters at the SQL level and narrows the tab counts', async () => {
      mockRegionGuard.stagedMode.mockResolvedValue('enforce');

      await service.getClarificationWorklist({ scope: { regions } });

      const rowCall = query.mock.calls.find((c) => !String(c[0]).includes('COUNT(*)'));
      const countCall = query.mock.calls.find((c) => String(c[0]).includes('COUNT(*)'));
      expect(String(rowCall?.[0])).toContain('b.region = ANY($1)');
      expect(rowCall?.[1]).toEqual([regions]);
      expect(String(countCall?.[0])).toContain('b.region = ANY($1)');
      expect(countCall?.[1]).toEqual([regions]);
    });
  });
});

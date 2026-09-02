import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { PipeTransform } from '@nestjs/common';
import { AuditLogController } from './audit.controller';

/**
 * `audit_events` is the fastest-growing table in this system and is deliberately exempt from
 * retention purging (`1790600000000-DataLifecycleIndexes.ts`), so it only ever gets longer, and
 * every row carries a `metadata` jsonb column. `/entity`, `/user` and `/recent` each read
 * `Number(limit)` into a TypeORM `take:` with nothing in the way — `?limit=500000` was a single
 * request asking for half a million of those rows.
 *
 * These read the pipe **off the route**: parse-limit.pipe.spec.ts already proves the pipe clamps,
 * so what can silently regress here is the binding. A parameter reverted to `@Query('limit')` on
 * any one of the three leaves every pipe test green and that route unbounded again.
 */
describe('audit-log list limit clamps', () => {
  /** The pipes Nest will actually run for a named `@Query()` parameter of `method`. */
  const pipesFor = (method: string, param: string): PipeTransform[] => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AuditLogController, method) ?? {};
    const entry = Object.values(args).find((a: any) => a?.data === param) as any;
    return entry?.pipes ?? [];
  };

  const clamp = (method: string, raw: unknown) => {
    const pipes = pipesFor(method, 'limit');
    expect(pipes).toHaveLength(1);
    return pipes[0].transform(raw, { type: 'query', data: 'limit' });
  };

  // Every route on this controller that reaches audit_events with a caller-supplied `take:`.
  const routes: Array<[string, string]> = [
    ['/audit-log/entity', 'getEntityHistory'],
    ['/audit-log/user', 'getUserActivity'],
    ['/audit-log/recent', 'getRecentActivity'],
  ];

  describe.each(routes)('%s', (_path, method) => {
    it('caps an over-large limit instead of honouring it', () => {
      expect(clamp(method, '500000')).toBe(500);
      expect(clamp(method, '501')).toBe(500);
    });

    it('keeps the route default of 50 when no limit is sent', () => {
      expect(clamp(method, undefined)).toBe(50);
    });

    it('passes a sane page size through untouched', () => {
      expect(clamp(method, '250')).toBe(250);
    });
  });

  /**
   * The three ceilings are one number on purpose. `/trail` reached 500 first, by hand, and three
   * sibling routes each picking their own would be the drift the shared constant exists to stop.
   */
  it('caps every audit_events route at the same 500 /trail already enforced', () => {
    const ceilings = routes.map(([, method]) => clamp(method, Number.MAX_SAFE_INTEGER));
    expect(ceilings).toEqual([500, 500, 500]);
  });

  /**
   * `/trail` keeps its inline `Math.min(Number(limit) || 200, 500)` rather than moving to the pipe
   * — it is already bounded, and parse-limit.pipe.ts cites it by name as the hand-rolled original.
   * This pins that it stays bounded by *something*: an unpiped parameter is fine here only for as
   * long as the clamp inside the method body survives.
   */
  it('leaves /trail on its own inline clamp, which must still bound the value', async () => {
    expect(pipesFor('getUnifiedTrail', 'limit')).toHaveLength(0);

    const unifiedAuditService = { getTrail: jest.fn().mockResolvedValue({ entries: [], countsBySource: {} }) };
    const controller = new AuditLogController({} as any, unifiedAuditService as any);

    await controller.getUnifiedTrail('entity-1', 'USER', 500000);

    expect(unifiedAuditService.getTrail).toHaveBeenCalledWith('entity-1', 'USER', 500);
  });
});

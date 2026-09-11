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
   * The four ceilings are one number on purpose. `/trail` reached 500 first, by hand, and the
   * sibling routes each picking their own would be the drift the shared constant exists to stop.
   */
  it('caps every audit_events route at the same 500 /trail already enforced', () => {
    const ceilings = routes.map(([, method]) => clamp(method, Number.MAX_SAFE_INTEGER));
    expect(ceilings).toEqual([500, 500, 500]);
  });

  /**
   * `/trail` HAS now moved to the pipe, and this replaces the case that said it should not.
   *
   * The previous decision was recorded here as "it is already bounded", and that was only half
   * true: `Math.min(Number(limit) || 200, 500)` bounds the value ABOVE and not BELOW.
   * `?limit=-5` is truthy, survives `|| 200`, and `Math.min(-5, 500)` is -5 — which reaches four
   * raw `LIMIT $n` interpolations in `UnifiedAuditService.getTrail`, where Postgres refuses it
   * ("LIMIT must not be negative") and each of the four is `.catch(() => [])`.
   *
   * Measured on the running rig against a record carrying 240 audit rows:
   *
   *     ?limit=<none>     200, 200 entries
   *     ?limit=20         200,  20 entries
   *     ?limit=-5         200,   0 entries     ← the whole trail, silently empty
   *     ?limit=5000000    200, 363 entries
   *
   * So the endpoint whose entire purpose is answering "what happened to this" reported that
   * nothing had, with a 200, for a record with 240 events behind it. That is the same defect
   * class the UI-truth sweep spent a day on — a refusal drawn as a confident answer — and it is
   * exactly what the pipe's floor removes.
   */
  it('puts /trail on the shared pipe too, because its inline clamp had no floor', () => {
    expect(clamp('getUnifiedTrail', '500000')).toBe(500);
    expect(clamp('getUnifiedTrail', undefined)).toBe(200);
    expect(clamp('getUnifiedTrail', '250')).toBe(250);
    // The four cases the inline clamp let through as a negative or a NaN.
    expect(clamp('getUnifiedTrail', '-5')).toBe(200);
    expect(clamp('getUnifiedTrail', '-1')).toBe(200);
    expect(clamp('getUnifiedTrail', '0')).toBe(200);
    expect(clamp('getUnifiedTrail', 'abc')).toBe(200);
  });

  it('hands the handler the clamped number, so the service never sees the raw ask', async () => {
    const unifiedAuditService = { getTrail: jest.fn().mockResolvedValue({ entries: [], countsBySource: {} }) };
    const controller = new AuditLogController({} as any, unifiedAuditService as any, {} as any);

    // 500 is what the pipe hands the method for `?limit=500000`; the method never sees 500000.
    await controller.getUnifiedTrail('entity-1', 'USER', 500);

    expect(unifiedAuditService.getTrail).toHaveBeenCalledWith('entity-1', 'USER', 500);
  });
});

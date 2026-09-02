import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { PipeTransform } from '@nestjs/common';
import { AssignmentController } from './assignment.controller';

/**
 * `GET /assignments` is the whole assignment book, and it hydrates every row it returns with six
 * relations. It used to put `Number(limit)` straight into `findAll`'s `take:`, so `?limit=60000`
 * against the 200k-row assignment table was one request asking the database for 60,000 rows and
 * this process to hold all of them fully joined — and every staff role on the route could send it.
 *
 * These read the pipe **off the route** rather than constructing a `ParseLimitPipe` directly.
 * parse-limit.pipe.spec.ts already proves the pipe clamps; what can silently regress here is the
 * binding — someone dropping the pipe argument, or reverting the parameter to `@Query('limit')`,
 * leaves a passing pipe test and an unbounded route.
 */
describe('GET /assignments limit clamp', () => {
  /** The pipes Nest will actually run for a named `@Query()` parameter of `method`. */
  const pipesFor = (method: string, param: string): PipeTransform[] => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AssignmentController, method) ?? {};
    const entry = Object.values(args).find((a: any) => a?.data === param) as any;
    return entry?.pipes ?? [];
  };

  const clamp = (raw: unknown) => {
    const pipes = pipesFor('findAll', 'limit');
    expect(pipes).toHaveLength(1);
    return pipes[0].transform(raw, { type: 'query', data: 'limit' });
  };

  it('caps an over-large limit instead of honouring it', () => {
    expect(clamp('60000')).toBe(200);
    expect(clamp('5000000')).toBe(200);
  });

  it('keeps the route default of 50 when no limit is sent', () => {
    expect(clamp(undefined)).toBe(50);
  });

  it('passes a sane page size through untouched', () => {
    expect(clamp('100')).toBe(100);
  });

  it('caps at the same 200 findByAssayer already enforces with MAX_ASSAYER_PAGE_SIZE', () => {
    expect(clamp('201')).toBe(200);
    expect(clamp('200')).toBe(200);
  });

  /**
   * The clamp is only half the fix: a caller that asked for 60,000 and received 200 has to be told
   * 200, or its next-page arithmetic is built on a number it never got.
   */
  it('reports the clamped limit back in the pagination meta, not the raw ask', async () => {
    const assignmentService = { findAll: jest.fn().mockResolvedValue({ assignments: [], total: 12345 }) };
    const controller = new AssignmentController(assignmentService as any, {} as any, {} as any);

    // 200 is what the pipe hands the method for `?limit=60000`; the method never sees the raw value.
    const res: any = await controller.findAll(1, 200);

    expect(assignmentService.findAll).toHaveBeenCalledWith(1, 200, undefined, undefined, false, undefined, undefined);
    expect(res.meta.pagination.limit).toBe(200);
    expect(res.meta.pagination.page).toBe(1);
  });
});

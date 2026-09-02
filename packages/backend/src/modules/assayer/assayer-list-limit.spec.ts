import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { PipeTransform } from '@nestjs/common';
import { AssayerController } from './assayer.controller';

/**
 * `GET /assayers` had no ceiling at all: `?limit=999999` returned every appraiser in one response.
 * The same defect closed on `/assignments` and the three audit routes.
 *
 * The ceiling is 1,000 rather than their 200, and that number is load-bearing rather than a guess.
 * This route has no search parameter, so a picker that must let any of 1,155 people be *found* has
 * no option but to hold the roster — `frontend/src/services/assayer-roster.ts` pages against this
 * endpoint and reports any shortfall. At 1,000 that is two requests; at 200 it would be six, on
 * three separate screens, for no gain. The abuse case is bounded either way.
 *
 * Read off the route rather than by constructing a `ParseLimitPipe`: `parse-limit.pipe.spec.ts`
 * already proves the pipe clamps. What can silently regress here is the *binding* — dropping the
 * pipe argument leaves every pipe test green and the route unbounded again.
 */
describe('GET /assayers limit clamp', () => {
  const pipesFor = (method: string, param: string): PipeTransform[] => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AssayerController, method) ?? {};
    const entry = Object.values(args).find((a: any) => a?.data === param) as any;
    return entry?.pipes ?? [];
  };

  const clamp = (raw: unknown) => {
    const pipes = pipesFor('findAll', 'limit');
    expect(pipes).toHaveLength(1);
    return pipes[0].transform(raw, { type: 'query', data: 'limit' });
  };

  it('caps an over-large limit instead of returning the whole roster', () => {
    expect(clamp('999999')).toBe(1000);
    expect(clamp('60000')).toBe(1000);
  });

  it('keeps the route default of 20 when no limit is sent', () => {
    expect(clamp(undefined)).toBe(20);
  });

  /**
   * The page size the roster helper asks for. If this ever stops being honoured, that helper pages
   * by what the server actually returned — so it still fetches everyone, just in more requests.
   */
  it('honours the 1,000 the whole-roster fetch asks for', () => {
    expect(clamp('1000')).toBe(1000);
  });

  it('passes an ordinary page size through untouched', () => {
    expect(clamp('50')).toBe(50);
  });
});

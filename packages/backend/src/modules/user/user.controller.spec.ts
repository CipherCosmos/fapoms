import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { PipeTransform } from '@nestjs/common';
import { UserController } from './user.controller';

/**
 * `GET /users` read `@Query('limit') limit = 20` straight off the query string with no ceiling at
 * all — not even the `ParseLimitPipe` clamp every sibling list route in this system already
 * carries (`/assayers`, `/assignments`, the audit routes). `?limit=999999` would ask
 * `UserService.findAll`'s `take:` for every account in the organisation in one response.
 *
 * `max: 2000` mirrors `/assayers`' generous ceiling rather than a tight one: this is the account
 * list behind an admin screen, the same shape of "hold the whole list" route `/assayers` is.
 *
 * Read off the route rather than by constructing a `ParseLimitPipe` directly — `parse-limit.pipe.
 * spec.ts` already proves the pipe itself clamps correctly. What can silently regress here is the
 * *binding*: dropping the pipe argument from the route leaves every pipe unit test green and the
 * route unbounded again, which is exactly the defect `assayer-list-limit.spec.ts` guards against
 * for `/assayers` and this file mirrors for `/users`.
 */
describe('GET /users limit clamp', () => {
  const pipesFor = (method: string, param: string): PipeTransform[] => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, UserController, method) ?? {};
    const entry = Object.values(args).find((a: any) => a?.data === param) as any;
    return entry?.pipes ?? [];
  };

  const clamp = (raw: unknown) => {
    const pipes = pipesFor('findAll', 'limit');
    expect(pipes).toHaveLength(1);
    return pipes[0].transform(raw, { type: 'query', data: 'limit' });
  };

  it('caps an over-large limit instead of returning every account in one response', () => {
    expect(clamp('999999')).toBe(2000);
    expect(clamp('60000')).toBe(2000);
  });

  it('keeps the route default of 20 when no limit is sent', () => {
    expect(clamp(undefined)).toBe(20);
  });

  it('honours the 2,000 ceiling exactly', () => {
    expect(clamp('2000')).toBe(2000);
  });

  it('passes an ordinary page size through untouched', () => {
    expect(clamp('50')).toBe(50);
  });

  /**
   * A query string is attacker-controlled input, not a trusted number — the same reasoning
   * `parse-limit.pipe.spec.ts` already covers generically. Pinned again here because this is the
   * binding that was missing entirely: before this fix, `?limit=abc` reached
   * `UserService.findAll`'s `take: NaN` unguarded.
   */
  it('treats garbage input the same as absent, never NaN or a negative take', () => {
    expect(clamp('abc')).toBe(20);
    expect(clamp('-5')).toBe(20);
    expect(clamp('0')).toBe(20);
  });
});

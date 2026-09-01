import { Injectable, PipeTransform, ArgumentMetadata } from '@nestjs/common';

/**
 * Clamp a `?limit=` (or similarly-shaped) query parameter to a sane, positive integer.
 *
 * About twenty list endpoints across this codebase read `Number(limit)` straight off the query
 * string and pass it to a TypeORM `take:` with no ceiling. `?limit=5000000` on any of them is a
 * single request asking the database to materialise, and the process to hold, five million rows
 * — a request the caller didn't mean and the server shouldn't attempt. `audit.controller.ts`
 * already hand-rolled the fix once inline (`Math.min(Number(limit) || 200, 500)`); this is that
 * fix, factored out so the next list endpoint doesn't reinvent it slightly differently, or skip
 * it entirely.
 *
 * Deliberately permissive about *what* garbage arrives — missing, `"abc"`, `"-5"`, `"0"`,
 * `"1e30"`, an array from a repeated query key — because a query string is attacker-controlled
 * input, not a trusted number. Anything that isn't a finite positive integer becomes `default`;
 * anything above `max` is clamped down to it; anything in between is floored and passed through.
 *
 * Usage: `@Query('limit', new ParseLimitPipe()) limit: number` for the common case, or
 * `new ParseLimitPipe({ default: 20, max: 200 })` when a route's existing behaviour (and its
 * tests) expect different numbers than the general default.
 */
@Injectable()
export class ParseLimitPipe implements PipeTransform<unknown, number> {
  private readonly default: number;
  private readonly max: number;

  constructor(options?: { default?: number; max?: number }) {
    this.default = options?.default ?? 50;
    this.max = options?.max ?? 200;
  }

  transform(value: unknown, _metadata: ArgumentMetadata): number {
    // A repeated query key (`?limit=1&limit=2`) arrives as an array; there is no single answer
    // to "how many", so it is treated the same as garbage and falls back to the default.
    const raw = Array.isArray(value) ? value[0] : value;
    const parsed = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return this.default;
    }

    // A fractional value below 1 (e.g. "0.5") would floor to 0, which is not a valid limit —
    // treat it the same as other invalid input rather than silently returning zero rows.
    const floored = Math.floor(parsed);
    if (floored <= 0) {
      return this.default;
    }
    return Math.min(floored, this.max);
  }
}

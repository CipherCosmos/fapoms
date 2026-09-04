import { Injectable, PipeTransform, ArgumentMetadata } from '@nestjs/common';

/**
 * Parse a `?page=` query parameter into a safe, 1-based integer.
 *
 * `page` almost always ends up as `(page - 1) * limit` handed to a query builder as `skip`.
 * Postgres rejects a negative `OFFSET` outright, and TypeORM refuses a non-numeric `skip`
 * before the query ever reaches the database — so `?page=0`, `?page=-1` and `?page=abc` each
 * throw out of the query layer as an unhandled `QueryFailedError` / `TypeORMError`, surfaced to
 * the caller as a 500. A malformed page number is exactly the kind of attacker- or bug-
 * controlled input `ParseLimitPipe` already guards `limit` against; `page` was the other half
 * of the same pair (`@Query('page') page = 1` with no pipe at all) and had no guard, on every
 * route that declared it that way.
 *
 * Deliberately permissive about what arrives, the same way `ParseLimitPipe` is: missing,
 * `"abc"`, `"-5"`, `"0"`, `"1.9"`, a repeated query key. Anything that isn't a finite integer
 * >= 1 becomes 1 — the first page — rather than a 400 or a crash. No upper bound: a page far
 * past the last one is not invalid input, it is a valid request that correctly returns zero
 * rows once `skip` legitimately exceeds the row count.
 *
 * Usage: `@Query('page', new ParsePagePipe()) page: number`.
 */
@Injectable()
export class ParsePagePipe implements PipeTransform<unknown, number> {
  transform(value: unknown, _metadata: ArgumentMetadata): number {
    // A repeated query key (`?page=1&page=2`) arrives as an array; there is no single answer to
    // "which page", so — matching ParseLimitPipe — only the first value is even considered.
    const raw = Array.isArray(value) ? value[0] : value;
    const parsed = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;

    if (!Number.isFinite(parsed) || parsed < 1) {
      return 1;
    }
    return Math.floor(parsed);
  }
}

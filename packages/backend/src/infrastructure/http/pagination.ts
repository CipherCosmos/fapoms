import type { PaginationMeta } from '@fapoms/shared';

/**
 * The `totalPages`/`hasNext`/`hasPrevious` formula, hand-duplicated identically across roughly a
 * dozen controllers (organization, holiday, branch, zone, user, client, …) — one canonical home so
 * a future change to what "has a next page" means does not have to land in a dozen places at once,
 * and so a new paginated route reaches for this instead of writing a thirteenth copy.
 */
export function buildPaginationMeta(params: { page: number; limit: number; total: number }): PaginationMeta {
  const { page, limit, total } = params;
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrevious: page > 1,
  };
}

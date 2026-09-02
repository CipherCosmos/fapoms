import { api } from './api';

/**
 * The whole appraiser roster, in as many requests as it takes.
 *
 * `GET /assayers` is paginated and has no search parameter — the controller accepts `page` and
 * `limit` and nothing else — so a screen that has to let somebody be *found* has no choice but to
 * hold the roster in memory. Three screens did that with a bare `?limit=1000` and no `withMeta`.
 * Against the customer's roster of 1,155 appraisers they received exactly 1,000 rows and had no
 * way to know the other 155 existed: the pay list under-counted by 155 people, and both pickers
 * offered a list those 155 were simply not in. Nobody was told. A manager who happened to be one
 * of them was absent from the dropdown exactly as though they had left the company.
 *
 * So the number of pages is read off the first response's `meta.pagination.total` and the rest are
 * fetched together. `missing` is what a screen must show: it is 0 for any roster this product will
 * realistically meet, and above 0 only when the roster outgrows the ceiling below or somebody is
 * added mid-fetch — either way the screen says so rather than quietly listing fewer people than it
 * has.
 */

/** Rows per request. Matches what the roster page asks for, so the server sees one shape of call. */
export const ASSAYER_PAGE_SIZE = 1000;

/**
 * The most pages one screen will ever fetch — 20,000 people.
 *
 * A ceiling exists so that a roster which has grown far beyond anything planned for cannot turn
 * one page-load into an unbounded burst of requests. Reaching it is reported through `missing`,
 * never swallowed: that is the whole point of the exercise.
 */
const MAX_PAGES = 20;

export interface WholeAssayerRoster<T> {
  people: T[];
  /** How many the server holds. Not always how many arrived. */
  total: number;
  /** People the server holds that are NOT in `people`. Zero means the list really is everyone. */
  missing: number;
}

interface RosterEnvelope<T> {
  data?: T[];
  meta?: { pagination?: { total?: number } };
}

export async function fetchWholeAssayerRoster<T extends { id: string }>(
  options?: { signal?: AbortSignal },
): Promise<WholeAssayerRoster<T>> {
  const fetchPage = (n: number) =>
    api.request<RosterEnvelope<T>>(`/assayers?page=${n}&limit=${ASSAYER_PAGE_SIZE}`, {
      // Without this the client unwraps the envelope and throws the pagination total away, which
      // is the single line whose absence made all of this invisible.
      withMeta: true,
      signal: options?.signal,
    });

  const first = await fetchPage(1);
  const firstRows = Array.isArray(first?.data) ? first.data : [];
  const total = first?.meta?.pagination?.total ?? firstRows.length;

  /**
   * Paged by what the server actually returned, not by what was asked for.
   *
   * `GET /assayers` does not clamp `limit` today, so asking for 1,000 yields 1,000 — but three
   * sibling routes were clamped to 200 this same week with `ParseLimitPipe`, and this one is the
   * obvious next. On the day that happens, computing the page count from the *requested* size would
   * fetch two pages of 200 for a 1,155-person roster and report 755 people missing: visible, thanks
   * to `missing`, but a needless failure. Reading the honoured size costs one line and makes the
   * clamp a non-event.
   */
  const effectivePageSize = Math.max(1, firstRows.length);
  const pagesNeeded = Math.min(Math.ceil(total / effectivePageSize) || 1, MAX_PAGES);
  const rest = pagesNeeded > 1
    ? await Promise.all(
      Array.from({ length: pagesNeeded - 1 }, (_, i) => fetchPage(i + 2)),
    )
    : [];

  /**
   * Keyed by id, because the server orders by creation date descending: one person enrolled while
   * these requests are in flight pushes every later page down a row, so the same record arrives on
   * two pages and the last record on the roster is pushed off the end. De-duplicating kills the
   * repeat, and the person who fell off the end shows up below as `missing: 1` — visible, rather
   * than a gap nobody could have detected.
   */
  const byId = new Map<string, T>();
  for (const page of [firstRows, ...rest.map((p) => (Array.isArray(p?.data) ? p.data : []))]) {
    for (const row of page) if (row && !byId.has(row.id)) byId.set(row.id, row);
  }
  const people = [...byId.values()];

  return { people, total, missing: Math.max(0, total - people.length) };
}

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
 * The server now also answers `GET /assayers/search` (typeahead, see `searchAssayers` below) —
 * a picker that only needs to let one person be *found* should use that instead of this loader.
 * This one stays for the few screens that genuinely need the whole roster (a pay list, a manager
 * picker whose options must all be visible at once), and now walks it with the `after` keyset
 * cursor rather than `page`/`limit`: offset paging re-scans everything before the page on every
 * request, which at 11,000 rows means the tenth page costs as much as the nine before it. `missing`
 * is what a screen must show: it is 0 for any roster this product will realistically meet, and
 * above 0 only when the roster outgrows the ceiling below or somebody is added mid-fetch — either
 * way the screen says so rather than quietly listing fewer people than it has.
 *
 * `RosterQueryService` has since grown real server-side filters (search text, stage, region, the
 * empanelment axes…), so this now takes an optional `query` string — see `fetchWholeAssayerRoster`
 * below — and walks every page of THAT filtered set rather than only ever the unfiltered roster.
 * The roster screen uses it this way; a caller that wants literally everyone (HrPayPage) simply
 * omits it, exactly as before.
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
  meta?: { pagination?: { total?: number; nextCursor?: string | null } };
}

/**
 * Still "every page it takes", but walked with the `after` keyset cursor rather than
 * `page`/`limit`. A cursor from the previous page's last row costs each request exactly what it
 * returns, and cannot double-count a row the way offset paging did when someone enrolled
 * mid-fetch (the de-dupe below is now a belt-and-braces check rather than the load-bearing fix
 * it used to be).
 */
export async function fetchWholeAssayerRoster<T extends { id: string }>(
  options?: {
    /**
     * Extra filters, already encoded — `toServerQuery(filters)` from the roster screen, nothing
     * at all for a caller that genuinely wants everyone (HrPayPage). `limit` and `after` are this
     * function's to set, so a caller passing either would be overruled. Matches the same
     * `query?: string` shape `fetchWholeBranchDirectory` already has, for the same reason: a
     * walker that fetches every page of a server-side-filtered list is one idea, used twice.
     */
    query?: string;
    signal?: AbortSignal;
  },
): Promise<WholeAssayerRoster<T>> {
  const extra = options?.query ? `&${options.query}` : '';
  const fetchPage = (after?: string) =>
    api.request<RosterEnvelope<T>>(
      `/assayers?limit=${ASSAYER_PAGE_SIZE}${extra}${after ? `&after=${encodeURIComponent(after)}` : ''}`,
      {
        // Without this the client unwraps the envelope and throws the pagination total away, which
        // is the single line whose absence made all of this invisible.
        withMeta: true,
        signal: options?.signal,
      },
    );

  const byId = new Map<string, T>();
  let total: number | undefined;
  let after: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    const page = await fetchPage(after);
    const rows = Array.isArray(page?.data) ? page.data : [];
    if (page?.meta?.pagination?.total !== undefined) total = page.meta.pagination.total;
    for (const row of rows) if (row && !byId.has(row.id)) byId.set(row.id, row);
    pagesFetched += 1;

    const nextCursor = page?.meta?.pagination?.nextCursor;
    if (!nextCursor || pagesFetched >= MAX_PAGES) break;
    after = nextCursor;
  }

  const people = [...byId.values()];
  // No total at all (an older or bare response) is treated as "what arrived is all there is".
  const resolvedTotal = total ?? people.length;
  return { people, total: resolvedTotal, missing: Math.max(0, resolvedTotal - people.length) };
}

/** A picker row — everything a typeahead result needs to render and nothing else. */
export interface AssayerSearchRow {
  id: string;
  assayerCode: string;
  displayName: string;
  state: string | null;
  lifecycleStatus: string;
  region: string | null;
}

/**
 * Typeahead against `GET /assayers/search`, for pickers that used to call
 * `fetchWholeAssayerRoster` just to let someone be found by name. Replaces a fetch of the whole
 * roster (up to 30 MB at 11,000 people) with one request for at most 50 rows, at the cost of the
 * caller debouncing keystrokes as the user types.
 */
export async function searchAssayers(
  q: string,
  options?: { limit?: number; signal?: AbortSignal },
): Promise<AssayerSearchRow[]> {
  const limit = options?.limit ?? 20;
  const res = await api.request<{ data?: AssayerSearchRow[] }>(
    `/assayers/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    { withMeta: true, signal: options?.signal },
  );
  return Array.isArray(res?.data) ? res.data : [];
}

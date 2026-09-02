import { api } from './api';

/**
 * Every branch a picker is allowed to offer, in as many requests as it takes.
 *
 * `GET /branches` clamps its page size server-side — `branch.controller.ts` reads it through
 * `new ParseLimitPipe({ default: 20, max: 200 })` — so the `?limit=1000` two pickers were sending
 * did not fetch a thousand branches. It fetched two hundred, silently, and the pages had no
 * `withMeta: true` with which to notice. Against the scale database's 20,097 branches that is
 * 19,897 branches a clerk could not add to a project and could not name in a rule; the search box
 * simply answered "No matching unassociated branches found." for a branch that plainly exists, and
 * a rule already pointed at one of them rendered its raw UUID where its name should be.
 *
 * So the page count is read off the first response's `meta.pagination.total` and the rest are
 * fetched. `missing` is what a screen must show: 0 for any client this product will realistically
 * meet, and above 0 only past the ceiling below or when a branch is added mid-fetch — either way
 * the screen says so rather than quietly offering a shorter list than it has.
 */

/**
 * Rows per request — the largest the controller will honour.
 *
 * Asking for more is not an error and not a bigger page: `ParseLimitPipe` clamps to 200 and
 * answers 200. Naming the real ceiling here is what makes the arithmetic below match what the
 * server does, and it is the single number that has to change if the pipe's `max` ever moves.
 */
export const BRANCH_PAGE_SIZE = 200;

/**
 * The most pages one picker will ever fetch — 10,000 branches, 50 requests.
 *
 * A ceiling exists because the clamp above makes branches five times more expensive to page than
 * the appraiser roster: the same 10,000 records that cost 10 requests at 1,000 a page cost 50 at
 * 200. 10,000 covers every client this system actually carries (the largest real one holds 72) and
 * all but the very biggest bank networks, while bounding one page-load to 50 requests — comfortably
 * inside the API's 300-per-minute-per-IP throttle. Reaching it is reported through `missing`, never
 * swallowed: that is the whole point of the exercise.
 */
const MAX_PAGES = 50;

/**
 * Requests in flight at once.
 *
 * The appraiser loader fires its remaining pages in one `Promise.all` because there are at most 19
 * of them. Fifty is a different animal: over HTTP/2 — which the Tailscale-Funnel deployment serves
 * — the browser does not queue them at six, it multiplexes all fifty onto one connection and the
 * API takes fifty concurrent paginated branch queries from a single page-load. A rolling pool
 * keeps six in the air and starts the next the moment one lands, so nothing sits behind a slow
 * batch-mate the way fixed waves would.
 */
const CONCURRENCY = 6;

export interface WholeBranchDirectory<T> {
  branches: T[];
  /** How many the server holds under this filter. Not always how many arrived. */
  total: number;
  /** Branches the server holds that are NOT in `branches`. Zero means the list really is all of them. */
  missing: number;
}

interface BranchEnvelope<T> {
  data?: T[];
  meta?: { pagination?: { total?: number } };
}

/** Runs `run(0…count-1)` with at most `width` outstanding at a time, results in index order. */
async function inPool<R>(count: number, width: number, run: (index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(count);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < count; i = next++) out[i] = await run(i);
  };
  await Promise.all(Array.from({ length: Math.min(width, count) }, worker));
  return out;
}

export async function fetchWholeBranchDirectory<T extends { id: string }>(
  options?: {
    /**
     * Extra filters, already encoded — `withScope(scope, { clientId })` on the Projects picker,
     * nothing at all on the Rules one. `page` and `limit` are this function's to set, so a caller
     * passing either would be overruled.
     */
    query?: string;
    signal?: AbortSignal;
  },
): Promise<WholeBranchDirectory<T>> {
  const prefix = options?.query ? `${options.query}&` : '';
  const fetchPage = (n: number) =>
    api.request<BranchEnvelope<T>>(`/branches?${prefix}page=${n}&limit=${BRANCH_PAGE_SIZE}`, {
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
   * `BRANCH_PAGE_SIZE` tracks `ParseLimitPipe`'s `max` today, but the two live in different
   * packages and nothing keeps them in step: the day the pipe drops to 100, paging by the
   * requested size would fetch half the pages it needs and report the rest missing. Reading the
   * honoured size costs one line and makes that a non-event.
   */
  const effectivePageSize = Math.max(1, firstRows.length);
  const pagesNeeded = Math.min(Math.ceil(total / effectivePageSize) || 1, MAX_PAGES);
  const rest = pagesNeeded > 1
    ? await inPool(pagesNeeded - 1, CONCURRENCY, (i) => fetchPage(i + 2))
    : [];

  /**
   * Keyed by id, because the list is ordered server-side: one branch created while these requests
   * are in flight shifts every later row along, so the same record arrives on two pages and the
   * record at the far end is pushed off. De-duplicating kills the repeat, and the branch that fell
   * off shows up below as `missing: 1` — visible, rather than a gap nobody could have detected.
   */
  const byId = new Map<string, T>();
  for (const page of [firstRows, ...rest.map((p) => (Array.isArray(p?.data) ? p.data : []))]) {
    for (const row of page) if (row && !byId.has(row.id)) byId.set(row.id, row);
  }
  const branches = [...byId.values()];

  return { branches, total, missing: Math.max(0, total - branches.length) };
}

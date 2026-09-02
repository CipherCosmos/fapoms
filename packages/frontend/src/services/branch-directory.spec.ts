import { fetchWholeBranchDirectory, BRANCH_PAGE_SIZE } from './branch-directory';
import { api } from './api';

jest.mock('./api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

/**
 * The loader that exists because two pickers only ever saw 200 branches.
 *
 * Every case below is one of the ways `/branches?limit=1000` could be short of the list without
 * saying so — starting with the one that is not hypothetical at all: the controller clamps the
 * page size to 200, so the thousand that was asked for was never on offer. The rule the tests hold
 * to is the one the screens depend on: whatever comes back, `branches.length + missing` accounts
 * for every branch the server said it had.
 */

const branch = (n: number) => ({ id: `b-${n}`, name: `Branch ${n}`, solId: `SOL${n}` });

/** One page of the list endpoint's envelope, exactly as the controller shapes it. */
const page = (firstIndex: number, count: number, total: number) => ({
  success: true,
  data: Array.from({ length: count }, (_, i) => branch(firstIndex + i)),
  meta: { pagination: { total } },
});

/** A server that honours `limit` up to its own clamp, over a list of `total` branches. */
const serveClampedAt = (clamp: number, total: number) =>
  mockRequest.mockImplementation(async (url: string) => {
    const q = new URLSearchParams(url.split('?')[1]);
    const size = Math.min(Number(q.get('limit')), clamp);
    const start = (Number(q.get('page')) - 1) * size + 1;
    return page(start, Math.max(0, Math.min(size, total - start + 1)), total);
  });

beforeEach(() => mockRequest.mockReset());

describe('fetchWholeBranchDirectory', () => {
  /** The live bug: a request for 1,000 that the controller answers with 200, and no way to know. */
  it('never asks for more than the 200 the controller will honour', async () => {
    mockRequest.mockResolvedValueOnce(page(1, 8, 8));

    await fetchWholeBranchDirectory();

    expect(BRANCH_PAGE_SIZE).toBe(200);
    expect(mockRequest).toHaveBeenCalledWith('/branches?page=1&limit=200', expect.anything());
  });

  it('asks for the pagination total, without which none of this is detectable', async () => {
    mockRequest.mockResolvedValueOnce(page(1, 8, 8));

    await fetchWholeBranchDirectory();

    expect(mockRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ withMeta: true }),
    );
  });

  /** A client of 3,412 branches: the picker used to hold 200 of them and search only those. */
  it('returns all 3,412 branches, not the 200 one request yields', async () => {
    serveClampedAt(200, 3412);

    const directory = await fetchWholeBranchDirectory<{ id: string; name: string }>();

    expect(directory.branches).toHaveLength(3412);
    expect(directory.missing).toBe(0);
    // The branch immediately past the old cut-off, and one near the far end.
    expect(directory.branches.map((b) => b.id)).toEqual(expect.arrayContaining(['b-201', 'b-3400']));
    expect(mockRequest).toHaveBeenCalledTimes(Math.ceil(3412 / 200));
  });

  it('makes one request for a client whose branches fit in one page', async () => {
    serveClampedAt(200, 72);

    const directory = await fetchWholeBranchDirectory();

    expect(directory.branches).toHaveLength(72);
    expect(directory.missing).toBe(0);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  /**
   * The Projects picker scopes to one client, and the header's own scope filter rides along. Those
   * have to survive on to page 2 — a second page fetched unfiltered would pour other clients'
   * branches into a picker that is supposed to offer one client's.
   */
  it('carries the caller filters on to every page, not just the first', async () => {
    serveClampedAt(200, 500);

    await fetchWholeBranchDirectory({ query: 'region=SOUTH&clientId=c-1' });

    for (const [url] of mockRequest.mock.calls) {
      expect(url).toContain('region=SOUTH');
      expect(url).toContain('clientId=c-1');
    }
    expect(mockRequest).toHaveBeenNthCalledWith(
      2, '/branches?region=SOUTH&clientId=c-1&page=2&limit=200', expect.anything(),
    );
  });

  it('sends no stray separator when the caller has no filters', async () => {
    mockRequest.mockResolvedValueOnce(page(1, 3, 3));

    await fetchWholeBranchDirectory();

    expect(mockRequest).toHaveBeenCalledWith('/branches?page=1&limit=200', expect.anything());
  });

  /**
   * The list is ordered server-side, so a branch created between two of these requests shifts every
   * later row along: one record arrives twice and the record at the far end is pushed off. The
   * repeat must not be counted as two branches, and the one that fell off must be reported.
   */
  it('does not count a repeated record twice, and reports the one it displaced', async () => {
    mockRequest
      .mockResolvedValueOnce(page(1, 200, 355))
      .mockResolvedValueOnce(page(200, 155, 355)); // starts one row earlier than it should

    const directory = await fetchWholeBranchDirectory<{ id: string }>();

    expect(new Set(directory.branches.map((b) => b.id)).size).toBe(directory.branches.length);
    expect(directory.branches).toHaveLength(354);
    expect(directory.missing).toBe(1);
  });

  /**
   * Past the ceiling the answer is genuinely partial, and has to say so rather than look whole —
   * the scale database's 20,097 branches are exactly this case.
   */
  it('stops at its ceiling and reports how many it never reached', async () => {
    serveClampedAt(200, 20_097);

    const directory = await fetchWholeBranchDirectory();

    expect(mockRequest).toHaveBeenCalledTimes(50);
    expect(directory.branches).toHaveLength(10_000);
    expect(directory.total).toBe(20_097);
    expect(directory.missing).toBe(10_097);
  });

  /**
   * `BRANCH_PAGE_SIZE` tracks `ParseLimitPipe`'s `max`, but the two live in different packages with
   * nothing keeping them in step. Paging by the size that was *requested* rather than the size that
   * came back would fetch half the pages it needs the day that clamp moves.
   */
  it('pages by what actually came back, so a tightened server clamp costs requests, not branches', async () => {
    serveClampedAt(100, 1155);

    const directory = await fetchWholeBranchDirectory();

    expect(directory.branches).toHaveLength(1155);
    expect(directory.missing).toBe(0);
    expect(mockRequest).toHaveBeenCalledTimes(Math.ceil(1155 / 100));
  });

  it('still reports a shortfall it cannot close, rather than reporting success', async () => {
    // A server clamped to 10 rows puts 1,155 branches beyond the 50-page ceiling.
    serveClampedAt(10, 1155);

    const directory = await fetchWholeBranchDirectory();

    expect(directory.branches.length).toBeLessThan(1155);
    expect(directory.branches.length + directory.missing).toBe(1155);
  });

  /** No meta at all (an older or bare response) is treated as "what arrived is all there is". */
  it('falls back to the rows it got when the server sends no total', async () => {
    mockRequest.mockResolvedValueOnce({ success: true, data: [branch(1), branch(2)] });

    const directory = await fetchWholeBranchDirectory();

    expect(directory.branches).toHaveLength(2);
    expect(directory.total).toBe(2);
    expect(directory.missing).toBe(0);
  });

  /**
   * Fifty requests is five times what the appraiser roster ever needs, because the clamp makes each
   * page five times smaller. Over HTTP/2 nothing in the browser queues them, so the pool has to.
   */
  it('keeps at most six requests in flight at once', async () => {
    let inFlight = 0;
    let peak = 0;
    mockRequest.mockImplementation((url: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const n = Number(new URLSearchParams(url.split('?')[1]).get('page'));
      return new Promise((resolve) => setTimeout(() => {
        inFlight -= 1;
        resolve(page((n - 1) * 200 + 1, 200, 8000));
      }, 1));
    });

    const directory = await fetchWholeBranchDirectory();

    expect(mockRequest).toHaveBeenCalledTimes(40);
    expect(peak).toBeLessThanOrEqual(6);
    expect(directory.missing).toBe(0);
  });
});

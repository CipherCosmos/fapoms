import { fetchWholeAssayerRoster, searchAssayers } from './assayer-roster';
import { api } from './api';

jest.mock('./api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

/**
 * The loader that exists because three screens each dropped 155 real people.
 *
 * Every case below is one of the ways the old `?limit=1000` call could be short of the roster
 * without saying so. The rule the tests hold to is the one the screens depend on: whatever comes
 * back, `people.length + missing` accounts for everybody the server said it had.
 *
 * Paging is now by the `after` keyset cursor rather than `page` — see `roster-query.service.ts`
 * on the backend — so these mocks drive it the way the real server now does: each response
 * carries `meta.pagination.nextCursor`, present only when there is another page to ask for.
 */

const person = (n: number) => ({ id: `a-${n}`, displayName: `Person ${n}` });

/** One page of the list endpoint's envelope, exactly as the controller shapes it. */
const page = (firstIndex: number, count: number, total: number, nextCursor: string | null = null) => ({
  success: true,
  data: Array.from({ length: count }, (_, i) => person(firstIndex + i)),
  meta: { pagination: { total, nextCursor } },
});

beforeEach(() => mockRequest.mockReset());

describe('fetchWholeAssayerRoster', () => {
  /** The live bug: 1,155 appraisers, a thousand-row request, 155 people nobody could see. */
  it('returns all 1,155 people, not the first 1,000', async () => {
    mockRequest
      .mockResolvedValueOnce(page(1, 1000, 1155, 'cursor-1'))
      .mockResolvedValueOnce(page(1001, 155, 1155, null));

    const roster = await fetchWholeAssayerRoster<{ id: string; displayName: string }>();

    expect(roster.people).toHaveLength(1155);
    expect(roster.missing).toBe(0);
    expect(roster.people.map((p) => p.id)).toContain('a-1100');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('asks for the pagination total, without which none of this is detectable', async () => {
    mockRequest.mockResolvedValueOnce(page(1, 8, 8, null));
    await fetchWholeAssayerRoster();
    expect(mockRequest).toHaveBeenCalledWith(
      '/assayers?limit=1000',
      expect.objectContaining({ withMeta: true }),
    );
  });

  it('carries the cursor forward on the next request', async () => {
    mockRequest
      .mockResolvedValueOnce(page(1, 2, 3, 'cursor-a'))
      .mockResolvedValueOnce(page(3, 1, 3, null));
    await fetchWholeAssayerRoster();
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      '/assayers?limit=1000&after=cursor-a',
      expect.objectContaining({ withMeta: true }),
    );
  });

  it('makes one request for a roster that fits in one page', async () => {
    mockRequest.mockResolvedValueOnce(page(1, 42, 42, null));
    const roster = await fetchWholeAssayerRoster();
    expect(roster.people).toHaveLength(42);
    expect(roster.missing).toBe(0);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('does not count a repeated record twice', async () => {
    mockRequest
      .mockResolvedValueOnce(page(1, 2, 3, 'cursor-a'))
      // A retried/overlapping page repeating the last row of the previous one.
      .mockResolvedValueOnce(page(2, 2, 3, null));

    const roster = await fetchWholeAssayerRoster<{ id: string }>();

    expect(new Set(roster.people.map((p) => p.id)).size).toBe(roster.people.length);
    expect(roster.people).toHaveLength(3);
  });

  /** Past the ceiling the answer is genuinely partial, and has to say so rather than look whole. */
  it('stops at its ceiling and reports how many it never reached', async () => {
    let call = 0;
    mockRequest.mockImplementation(() => {
      call += 1;
      return Promise.resolve(page((call - 1) * 1000 + 1, 1000, 25_000, `cursor-${call}`));
    });

    const roster = await fetchWholeAssayerRoster();

    expect(mockRequest).toHaveBeenCalledTimes(20);
    expect(roster.people).toHaveLength(20_000);
    expect(roster.total).toBe(25_000);
    expect(roster.missing).toBe(5_000);
  });

  /** No meta at all (an older or bare response) is treated as "what arrived is all there is". */
  it('falls back to the rows it got when the server sends no total', async () => {
    mockRequest.mockResolvedValueOnce({ success: true, data: [person(1), person(2)] });
    const roster = await fetchWholeAssayerRoster();
    expect(roster.people).toHaveLength(2);
    expect(roster.total).toBe(2);
    expect(roster.missing).toBe(0);
  });
});

describe('fetchWholeAssayerRoster — when the server honours a smaller page than asked for', () => {
  it('keeps following the cursor however many rows a page actually returns', async () => {
    let call = 0;
    mockRequest.mockImplementation(() => {
      call += 1;
      const start = (call - 1) * 200 + 1;
      const count = Math.max(0, Math.min(200, 1155 - start + 1));
      const isLast = start + count - 1 >= 1155;
      return Promise.resolve(page(start, count, 1155, isLast ? null : `cursor-${call}`));
    });

    const result = await fetchWholeAssayerRoster<{ id: string }>();

    expect(result.people).toHaveLength(1155);
    expect(result.missing).toBe(0);
    // ceil(1155 / 200) = 6 requests, rather than the 2 a 1,000-row page would need.
    expect(mockRequest).toHaveBeenCalledTimes(6);
  });

  it('still reports a shortfall it cannot close, rather than reporting success', async () => {
    let call = 0;
    mockRequest.mockImplementation(() => {
      call += 1;
      return Promise.resolve(page((call - 1) * 10 + 1, 10, 1155, `cursor-${call}`));
    });

    const result = await fetchWholeAssayerRoster<{ id: string }>();

    expect(result.people.length).toBeLessThan(1155);
    expect(result.people.length + result.missing).toBe(1155);
  });
});

describe('searchAssayers', () => {
  it('hits the typeahead route with the query and a capped limit', async () => {
    mockRequest.mockResolvedValueOnce({ success: true, data: [{ id: 'a-1', displayName: 'Ravi' }] });
    const rows = await searchAssayers('ravi', { limit: 10 });
    expect(mockRequest).toHaveBeenCalledWith(
      '/assayers/search?q=ravi&limit=10',
      expect.objectContaining({ withMeta: true }),
    );
    expect(rows).toEqual([{ id: 'a-1', displayName: 'Ravi' }]);
  });

  it('returns an empty list rather than throwing when the server sends no data', async () => {
    mockRequest.mockResolvedValueOnce({ success: true });
    expect(await searchAssayers('x')).toEqual([]);
  });
});

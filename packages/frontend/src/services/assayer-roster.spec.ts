import { fetchWholeAssayerRoster } from './assayer-roster';
import { api } from './api';

jest.mock('./api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

/**
 * The loader that exists because three screens each dropped 155 real people.
 *
 * Every case below is one of the ways the old `?limit=1000` call could be short of the roster
 * without saying so. The rule the tests hold to is the one the screens depend on: whatever comes
 * back, `people.length + missing` accounts for everybody the server said it had.
 */

const person = (n: number) => ({ id: `a-${n}`, displayName: `Person ${n}` });

/** One page of the list endpoint's envelope, exactly as the controller shapes it. */
const page = (firstIndex: number, count: number, total: number) => ({
  success: true,
  data: Array.from({ length: count }, (_, i) => person(firstIndex + i)),
  meta: { pagination: { total } },
});

beforeEach(() => mockRequest.mockReset());

describe('fetchWholeAssayerRoster', () => {
  /** The live bug: 1,155 appraisers, a thousand-row request, 155 people nobody could see. */
  it('returns all 1,155 people, not the first 1,000', async () => {
    mockRequest
      .mockResolvedValueOnce(page(1, 1000, 1155))
      .mockResolvedValueOnce(page(1001, 155, 1155));

    const roster = await fetchWholeAssayerRoster<{ id: string; displayName: string }>();

    expect(roster.people).toHaveLength(1155);
    expect(roster.missing).toBe(0);
    expect(roster.people.map((p) => p.id)).toContain('a-1100');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('asks for the pagination total, without which none of this is detectable', async () => {
    mockRequest.mockResolvedValueOnce(page(1, 8, 8));
    await fetchWholeAssayerRoster();
    expect(mockRequest).toHaveBeenCalledWith(
      '/assayers?page=1&limit=1000',
      expect.objectContaining({ withMeta: true }),
    );
  });

  it('makes one request for a roster that fits in one page', async () => {
    mockRequest.mockResolvedValueOnce(page(1, 42, 42));
    const roster = await fetchWholeAssayerRoster();
    expect(roster.people).toHaveLength(42);
    expect(roster.missing).toBe(0);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  /**
   * The pages are ordered newest-first, so somebody enrolled between the two requests shifts every
   * later row down one: one record arrives twice, and the oldest record is pushed off the end.
   * The repeat must not be counted as two people, and the one that fell off must be reported.
   */
  it('does not count a repeated record twice, and reports the one it displaced', async () => {
    mockRequest
      .mockResolvedValueOnce(page(1, 1000, 1155))
      .mockResolvedValueOnce(page(1000, 155, 1155)); // starts one row earlier than it should

    const roster = await fetchWholeAssayerRoster<{ id: string }>();

    expect(new Set(roster.people.map((p) => p.id)).size).toBe(roster.people.length);
    expect(roster.people).toHaveLength(1154);
    expect(roster.missing).toBe(1);
  });

  /** Past the ceiling the answer is genuinely partial, and has to say so rather than look whole. */
  it('stops at its ceiling and reports how many it never reached', async () => {
    mockRequest.mockImplementation((url: string) => {
      const n = Number(new URLSearchParams(url.split('?')[1]).get('page'));
      return Promise.resolve(page((n - 1) * 1000 + 1, 1000, 25_000));
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

/**
 * The server is allowed to hand back fewer rows than were asked for.
 *
 * `GET /assayers` was unclamped when this loader was written, so a request for 1,000 got 1,000.
 * It is clamped now (max 1,000, `assayer-list-limit.spec.ts`), and three sibling routes were
 * clamped to **200** in the same pass — so the ceiling here moving down one day is a realistic
 * change, not a hypothetical. Paging by the size that was *requested* would then fetch two pages
 * of 200 for a 1,155-person roster and call the other 755 missing.
 */
describe('fetchWholeAssayerRoster — when the server honours a smaller page than asked for', () => {
  it('pages by what actually came back, so a tightened server limit costs requests, not people', async () => {
    // Every page returns 200 rows though 1,000 were requested — a ParseLimitPipe capped at 200.
    mockRequest.mockImplementation(async (url: string) => {
      const p = Number(new URLSearchParams(url.split('?')[1]).get('page'));
      const start = (p - 1) * 200 + 1;
      const count = Math.max(0, Math.min(200, 1155 - start + 1));
      return page(start, count, 1155);
    });

    const result = await fetchWholeAssayerRoster<{ id: string }>();

    expect(result.people).toHaveLength(1155);
    expect(result.missing).toBe(0);
    // ceil(1155 / 200) = 6 requests, rather than the 2 a 1,000-row page would need.
    expect(mockRequest).toHaveBeenCalledTimes(6);
  });

  it('still reports a shortfall it cannot close, rather than reporting success', async () => {
    // A server that caps at 10 rows puts 1,155 people beyond the 20-page ceiling.
    mockRequest.mockImplementation(async (url: string) => {
      const p = Number(new URLSearchParams(url.split('?')[1]).get('page'));
      return page((p - 1) * 10 + 1, 10, 1155);
    });

    const result = await fetchWholeAssayerRoster<{ id: string }>();

    expect(result.people.length).toBeLessThan(1155);
    expect(result.people.length + result.missing).toBe(1155);
  });
});

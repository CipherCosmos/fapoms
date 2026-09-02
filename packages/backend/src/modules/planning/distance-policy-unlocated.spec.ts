import { DistancePolicyFilter } from './recommendation.engine';

/**
 * A conflict-of-interest floor that cannot be measured must not report itself as satisfied.
 *
 * `minDistanceKm` is a compliance control: an assayer must not audit a branch on their own
 * doorstep. Both missing coordinates used to fall through to `return true` together, so an assayer
 * whose home had never been geocoded silently PASSED — the system asserted "far enough from this
 * branch" about someone whose address it did not know.
 *
 * It was not a rare corner. On the day this was found, 310 of the 548 offerable assayers had no
 * coordinate, because the roster had been imported that morning and the precision backfill geocodes
 * at roughly one address per second by the providers' rate limit. Every one of them passed this
 * control without being checked.
 */
describe('DistancePolicyFilter — a floor that cannot be measured is not a floor that was met', () => {
  /** Passes anything it is actually able to measure, so these tests isolate the null handling. */
  const evaluator = { checkDistancePolicy: jest.fn().mockReturnValue({ passed: true }) };
  const filter = new DistancePolicyFilter(evaluator as any);

  const CLIENT_WITH_FLOOR = { planningPreferences: { minDistanceKm: 5 } };
  const LOCATED_BRANCH = { latitude: 10.7867, longitude: 76.6548 };

  const assayer = (lat: number | null, lng: number | null) =>
    ({ id: 'a-1', displayName: 'Shinil T', latitude: lat, longitude: lng,
       homeLatitude: lat, homeLongitude: lng } as any);

  beforeEach(() => evaluator.checkDistancePolicy.mockClear());

  it('excludes an assayer whose home was never located, rather than passing them', async () => {
    const passed = await filter.evaluate(assayer(null, null), {
      client: CLIENT_WITH_FLOOR, branch: LOCATED_BRANCH,
    } as any);

    expect(passed).toBe(false);
    // And it never pretended to measure anything.
    expect(evaluator.checkDistancePolicy).not.toHaveBeenCalled();
  });

  it('says the reason was an unknown address, not an unmet distance', async () => {
    expect(filter.unlocatedHome(assayer(null, null))).toBe(true);
    expect(filter.unlocatedHome(assayer(10.78, 76.65))).toBe(false);
  });

  /**
   * The other null is a different fact. A branch with no coordinate is not the assayer's doing, and
   * excluding on it would empty the candidate list for that branch with no way for ops to reopen
   * it — the same reasoning the engine's `maxDistanceKm` handling already records.
   */
  it('still passes when it is the BRANCH that has no coordinate', async () => {
    const passed = await filter.evaluate(assayer(10.78, 76.65), {
      client: CLIENT_WITH_FLOOR, branch: { latitude: null, longitude: null },
    } as any);

    expect(passed).toBe(true);
  });

  /**
   * Scoped to clients that asked for the control. 2 of 24 clients set `minDistanceKm`; the other 22
   * must see no change in who is planned for them.
   */
  it('does not narrow planning for a client with no distance policy', async () => {
    const passed = await filter.evaluate(assayer(null, null), {
      client: { planningPreferences: null }, branch: LOCATED_BRANCH,
    } as any);

    expect(passed).toBe(true);
  });

  it('measures normally once the address has been located', async () => {
    const passed = await filter.evaluate(assayer(10.78, 76.65), {
      client: CLIENT_WITH_FLOOR, branch: LOCATED_BRANCH,
    } as any);

    expect(passed).toBe(true);
    expect(evaluator.checkDistancePolicy).toHaveBeenCalledTimes(1);
  });
});

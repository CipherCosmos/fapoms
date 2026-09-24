import { PricingController } from './pricing.controller';
import { DAY_TRAVEL_QUERY_MARKER } from '../assignment/assignment-day-travel';

/**
 * B6 (2026-09-24): the assign form's fee is pre-filled from `POST /pricing/quote`. Asked for the
 * form's day, the quote now applies travel-once-per-day: when another of the assayer's jobs that day
 * already carries the journey, the answer is the base-only price, flagged `travelAlreadyCharged`.
 */
describe('POST /pricing/quote — travel once per assayer per day', () => {
  const build = (travelPaidThatDay: boolean) => {
    const query = jest.fn(async (sql: string, _params?: unknown[]) =>
      (sql.includes(DAY_TRAVEL_QUERY_MARKER) && travelPaidThatDay ? [{ id: 'other-job' }] : []));
    const quote = jest.fn(async (input: any) => ({
      baseFee: 1200, travelFee: input.distanceKm > 0 ? 400 : 0, total: input.distanceKm > 0 ? 1600 : 1200,
      distanceKm: input.distanceKm,
    }));
    const c = new PricingController(
      { quote, resolveClientIdForProject: jest.fn(async () => null) } as any,
      { findOne: jest.fn(async () => null), manager: { query } } as any,
    );
    return { c, quote, query };
  };
  const body = { assayerId: '11111111-1111-4111-8111-111111111111', distanceKm: 40 } as any;

  it('quotes base-only, flagged, when that day\'s travel is already paid', async () => {
    const { c, query } = build(true);
    const out: any = await c.quote({ ...body, onDate: '2026-10-05', excludeAssignmentId: '22222222-2222-4222-8222-222222222222' });
    expect(out).toMatchObject({ total: 1200, travelFee: 0, distanceKm: 40, travelAlreadyCharged: true });
    // The job being moved does not count as the day's traveller.
    expect(query.mock.calls[0][1]).toEqual(expect.arrayContaining(['22222222-2222-4222-8222-222222222222']));
  });

  it('quotes the journey when the day is otherwise theirs to travel', async () => {
    const { c } = build(false);
    const out: any = await c.quote({ ...body, onDate: '2026-10-05' });
    expect(out.total).toBe(1600);
    expect(out.travelAlreadyCharged).toBeUndefined();
  });

  it('without a day it is the plain quote, and asks nothing about the day', async () => {
    const { c, query } = build(true);
    const out: any = await c.quote(body);
    expect(out.total).toBe(1600);
    expect(query).not.toHaveBeenCalled();
  });
});

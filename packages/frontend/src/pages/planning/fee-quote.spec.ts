import { feeQuoteRequestBody, dayTravelNote, TRAVEL_ALREADY_PAID_NOTE, homeRouteOf, liveDistanceNote, cappedCandidatesNote } from './fee-quote';

/**
 * Travel is paid once per assayer per day. The assign form's quote has to be asked FOR the form's
 * date, or it shows a travel-inclusive figure for an assayer's second job that day.
 */
describe('feeQuoteRequestBody', () => {
  it('asks for the form\'s date as onDate (YYYY-MM-DD)', () => {
    const body = feeQuoteRequestBody({ assayerId: 'a1', distanceKm: 12, onDate: '2026-09-30' });
    expect(body.onDate).toBe('2026-09-30');
  });

  it('trims a timestamp to its date and drops something that is not a date', () => {
    expect(feeQuoteRequestBody({ assayerId: 'a1', onDate: '2026-09-30T00:00:00.000Z' }).onDate).toBe('2026-09-30');
    expect(feeQuoteRequestBody({ assayerId: 'a1', onDate: 'soon' })).not.toHaveProperty('onDate');
  });

  it('names the job being moved on a reassign, and only then', () => {
    expect(feeQuoteRequestBody({ assayerId: 'a1', excludeAssignmentId: 'asg-1' }).excludeAssignmentId).toBe('asg-1');
    expect(feeQuoteRequestBody({ assayerId: 'a1' })).not.toHaveProperty('excludeAssignmentId');
  });

  it('sends a routed duration and its source only when there is one', () => {
    const routed = feeQuoteRequestBody({ assayerId: 'a1', distanceKm: 20, durationMinutes: 35, distanceSource: 'OSRM' });
    expect(routed).toMatchObject({ distanceKm: 20, durationMinutes: 35, roadSource: 'OSRM' });
    const flat = feeQuoteRequestBody({ assayerId: 'a1', distanceKm: null, durationMinutes: 0 });
    expect(flat.distanceKm).toBe(0);
    expect(flat.durationMinutes).toBeUndefined();
    expect(flat.roadSource).toBeUndefined();
  });
});

describe('dayTravelNote', () => {
  it('says the travel is already paid when the server says so', () => {
    expect(dayTravelNote({ travelAlreadyCharged: true })).toBe(TRAVEL_ALREADY_PAID_NOTE);
    expect(TRAVEL_ALREADY_PAID_NOTE).toBe('Travel already paid on another job this day — base fee only.');
  });

  it('says nothing otherwise', () => {
    expect(dayTravelNote({ travelAlreadyCharged: false })).toBeNull();
    expect(dayTravelNote({})).toBeNull();
    expect(dayTravelNote(null)).toBeNull();
  });
});

/**
 * F2 (2026-09-25): live location ranks; home prices. The assign form quoted travel from where the
 * phone was ("6 km away") while the server booked it from a home 140 km off.
 */
describe('homeRouteOf — the job is priced from home', () => {
  const live = {
    distanceKm: 6, durationMinutes: 12, distanceSource: 'OSRM' as const,
    homeDistanceKm: 140, homeDurationMinutes: 170, homeDistanceSource: 'OSRM' as const,
    rankedFromLive: true,
  };

  it('uses the home figures, not the live ranking figures', () => {
    expect(homeRouteOf(live)).toEqual({ distanceKm: 140, durationMinutes: 170, distanceSource: 'OSRM' });
  });

  it('feeds the quote body the home distance', () => {
    const home = homeRouteOf(live);
    expect(feeQuoteRequestBody({ assayerId: 'a1', distanceKm: home.distanceKm, durationMinutes: home.durationMinutes, distanceSource: home.distanceSource }).distanceKm).toBe(140);
  });

  it('says home is unknown rather than pricing from the live fix when home is not located', () => {
    expect(homeRouteOf({ ...live, homeDistanceKm: null, homeDurationMinutes: null, homeDistanceSource: null }).distanceKm).toBeNull();
    // An older payload with no home fields but a live ranking: still not the live figure.
    expect(homeRouteOf({ distanceKm: 6, rankedFromLive: true }).distanceKm).toBeNull();
  });

  it('for somebody ranked from home, the two are the same', () => {
    expect(homeRouteOf({ distanceKm: 30, durationMinutes: 40, distanceSource: 'OSRM' }).distanceKm).toBe(30);
  });

  it('labels a live distance as "currently … away", and only a live one', () => {
    const fmt = (km: number) => `${km} km`;
    expect(liveDistanceNote(live, fmt)).toBe('currently 6 km away');
    expect(liveDistanceNote({ ...live, rankedFromLive: false }, fmt)).toBeNull();
  });
});

describe('cappedCandidatesNote — a capped list says it is capped (F9)', () => {
  it('names the shown and ranked counts', () => {
    expect(cappedCandidatesNote(100, 412)).toMatch(/top 100 of 412/);
  });
  it('says nothing when everyone ranked is shown', () => {
    expect(cappedCandidatesNote(40, 40)).toBeNull();
  });
});

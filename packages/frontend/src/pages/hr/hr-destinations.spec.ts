import { resolveHrDestination } from './hr-destinations';

/**
 * Where an old link to this section lands.
 *
 * The workforce console has been reorganised twice — eleven screens to seven, then seven to
 * four — and each round retired URLs that are still out there: the backend worklist hands the
 * Overview a `link` per row, notification payloads carry `?tab=` values, and people bookmark.
 * A retired page must land on the thing that answers the same question, not on the section's
 * front door; arriving somewhere plausible with no idea which of four tabs held the answer
 * wastes more time than a dead link would.
 */
describe('resolving an HR destination', () => {
  it('sends the retired concern pages to the chip that lists the same people', () => {
    expect(resolveHrDestination('/hr/records')).toBe('/hr/roster?segment=incomplete');
    expect(resolveHrDestination('/hr/compliance')).toBe('/hr/roster?segment=lapsed');
    expect(resolveHrDestination('/hr/onboarding')).toBe('/hr/roster?segment=onboarding');
    expect(resolveHrDestination('/hr/capability')).toBe('/hr/roster?segment=lapsed');
    expect(resolveHrDestination('/hr/paperwork')).toBe('/hr/roster?segment=incomplete');
  });

  it('keeps the merged views reachable by their own chips', () => {
    expect(resolveHrDestination('/hr/utilisation')).toBe('/hr/where?view=workload');
    expect(resolveHrDestination('/hr/deployment')).toBe('/hr/where?view=coverage');
    expect(resolveHrDestination('/hr/activity')).toBe('/hr/where?view=changes');
  });

  it('carries a query string through to a live destination', () => {
    // This is the whole point of the worklist's links. Dropping the query — which an earlier
    // version did, by splitting on '?' and discarding the tail — landed "709 missing emergency
    // contact" on the roster showing all 1,163 people, with no sign which were meant.
    expect(resolveHrDestination('/hr/roster?segment=incomplete')).toBe('/hr/roster?segment=incomplete');
    expect(resolveHrDestination('/hr/where?view=coverage')).toBe('/hr/where?view=coverage');
  });

  it('lets a mapped destination keep its own chip over whatever the caller appended', () => {
    // `/hr/records` means the incomplete-record segment. A stale `?view=details` on the end is
    // the retired page's vocabulary and means nothing where it is going.
    expect(resolveHrDestination('/hr/records?view=details')).toBe('/hr/roster?segment=incomplete');
  });

  it('leaves the live destinations alone', () => {
    expect(resolveHrDestination('/hr')).toBe('/hr');
    expect(resolveHrDestination('/hr/roster')).toBe('/hr/roster');
    expect(resolveHrDestination('/hr/pay')).toBe('/hr/pay');
  });

  it('treats an empty or overview link as the section front door', () => {
    expect(resolveHrDestination('')).toBe('/hr');
    expect(resolveHrDestination('overview')).toBe('/hr');
    expect(resolveHrDestination('/hr/')).toBe('/hr');
  });
});

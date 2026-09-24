import { isHorizontalSwipe, nextSegment, shouldClaimSwipe } from './swipe-segments';

const TABS = ['ACTIVE', 'HISTORY'] as const;

describe('nextSegment', () => {
  it('a left swipe moves forward and a right swipe moves back', () => {
    expect(nextSegment(TABS, 'ACTIVE', -80)).toBe('HISTORY');
    expect(nextSegment(TABS, 'HISTORY', 80)).toBe('ACTIVE');
  });

  /**
   * The defect: the responder read `current` from its first render, so after reaching HISTORY it
   * still computed from ACTIVE and a right swipe went nowhere. Deciding from the value passed in
   * each time is what lets a swipe come back.
   */
  it('works from whichever segment is current now, in both directions', () => {
    let current: (typeof TABS)[number] = 'ACTIVE';
    current = nextSegment(TABS, current, -80) ?? current;
    expect(current).toBe('HISTORY');
    current = nextSegment(TABS, current, 80) ?? current;
    expect(current).toBe('ACTIVE');
  });

  it('goes nowhere past either end, or from an unknown segment', () => {
    expect(nextSegment(TABS, 'ACTIVE', 80)).toBeNull();
    expect(nextSegment(TABS, 'HISTORY', -80)).toBeNull();
    expect(nextSegment(TABS, 'OTHER' as any, -80)).toBeNull();
  });
});

describe('shouldClaimSwipe', () => {
  it('claims a horizontal swipe that has a segment to move to', () => {
    expect(shouldClaimSwipe(TABS, 'ACTIVE', -40, 0)).toBe(true);
    expect(shouldClaimSwipe(TABS, 'HISTORY', 40, 0)).toBe(true);
  });

  it('leaves a swipe past the end for the app-level tab swipe', () => {
    expect(shouldClaimSwipe(TABS, 'ACTIVE', 40, 0)).toBe(false);
    expect(shouldClaimSwipe(TABS, 'HISTORY', -40, 0)).toBe(false);
  });

  it('never claims a vertical scroll or a small drift', () => {
    expect(shouldClaimSwipe(TABS, 'ACTIVE', -20, 0)).toBe(false);
    expect(shouldClaimSwipe(TABS, 'ACTIVE', -40, 40)).toBe(false);
    expect(isHorizontalSwipe(-40, 10)).toBe(true);
  });
});

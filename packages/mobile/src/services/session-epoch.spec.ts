import { advanceSession, isStampCurrent, stampSession, __resetSessionEpochForTests } from './session-epoch';

beforeEach(() => __resetSessionEpochForTests());

describe('session stamps', () => {
  it('a read started in the live session may land', () => {
    advanceSession('A');
    const stamp = stampSession();
    expect(isStampCurrent(stamp)).toBe(true);
  });

  /** The defect: a schedule read in flight at sign-out was written after the wipe. */
  it('is stale once the session has ended', () => {
    advanceSession('A');
    const stamp = stampSession();
    advanceSession(null);
    expect(isStampCurrent(stamp)).toBe(false);
  });

  it("is stale once somebody else has signed in — A's answer never reaches B", () => {
    advanceSession('A');
    const stamp = stampSession();
    advanceSession(null);
    advanceSession('B');
    expect(isStampCurrent(stamp)).toBe(false);
  });

  it('is stale even if the same person signed out and back in (the wipe still stands)', () => {
    advanceSession('A');
    const stamp = stampSession();
    advanceSession(null);
    advanceSession('A');
    expect(isStampCurrent(stamp)).toBe(false);
  });

  it('a read started with nobody signed in never lands', () => {
    expect(isStampCurrent(stampSession())).toBe(false);
  });
});

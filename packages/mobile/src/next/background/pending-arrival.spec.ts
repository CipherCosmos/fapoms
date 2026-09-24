import {
  backgroundIntervalMinutes,
  decidePending,
  endOfIstDay,
  insideCircle,
  istDayKey,
  reminderTime,
  type PendingArrival,
} from './pending-arrival';

// 24 Sep 2026, 08:40 IST = 03:10 UTC.
const at = (hh: number, mm: number) => new Date(Date.UTC(2026, 8, 24, hh - 5, mm - 30));

const pending: PendingArrival = {
  assignmentId: 'a',
  label: 'Kothrud, SBI',
  noticedAt: at(8, 40).toISOString(),
  opensAt: at(9, 0).toISOString(),
  istDay: '2026-09-24',
  latitude: 18.5,
  longitude: 73.8,
  radius: 200,
};
const insideFix = { latitude: 18.5005, longitude: 73.8, accuracy: 20, timestamp: at(9, 5).getTime() }; // ~55 m
const outsideFix = { latitude: 18.51, longitude: 73.8, accuracy: 20, timestamp: at(9, 5).getTime() }; // ~1.1 km

describe('IST day', () => {
  it('uses IST whatever the phone’s zone says', () => {
    expect(istDayKey(new Date(Date.UTC(2026, 8, 24, 18, 29)))).toBe('2026-09-24'); // 23:59 IST
    expect(istDayKey(new Date(Date.UTC(2026, 8, 24, 18, 30)))).toBe('2026-09-25'); // 00:00 IST
  });
  it('ends at IST midnight', () => {
    expect(endOfIstDay(at(8, 40)).toISOString()).toBe('2026-09-24T18:30:00.000Z');
  });
});

describe('decidePending', () => {
  it('waits until check-in opens', () => {
    expect(decidePending(pending, { now: at(8, 50), fix: insideFix })).toEqual({ kind: 'wait' });
  });

  it('asks for one position once open, then checks in if still inside', () => {
    expect(decidePending(pending, { now: at(9, 1), fix: null })).toEqual({ kind: 'need-position' });
    expect(decidePending(pending, { now: at(9, 5), fix: insideFix })).toEqual({ kind: 'check-in' });
  });

  it('gives up when they are outside, or the OS saw them leave', () => {
    expect(decidePending(pending, { now: at(9, 5), fix: outsideFix })).toEqual({ kind: 'give-up', why: 'outside' });
    expect(decidePending({ ...pending, leftAt: at(8, 55).toISOString() }, { now: at(8, 56), fix: null })).toEqual({ kind: 'give-up', why: 'left' });
  });

  it('gives up at the end of the IST day', () => {
    expect(decidePending(pending, { now: new Date(Date.UTC(2026, 8, 24, 18, 31)), fix: insideFix })).toEqual({ kind: 'give-up', why: 'day-over' });
  });

  it('stops if the job was checked in some other way, removed, or moved on', () => {
    for (const current of [{ checkedInAt: 'x' }, { status: 'CHECKED_IN' }, { isActive: false }, { status: 'CANCELLED' }]) {
      expect(decidePending(pending, { now: at(9, 5), fix: insideFix, current })).toEqual({ kind: 'give-up', why: 'already-checked-in' });
    }
    expect(decidePending(pending, { now: at(9, 5), fix: insideFix, current: { status: 'ACCEPTED' } })).toEqual({ kind: 'check-in' });
  });
});

describe('insideCircle', () => {
  it('allows for the reading’s accuracy, but only up to 100 m', () => {
    const edge = { latitude: 18.5026, longitude: 73.8, timestamp: 0 }; // ~289 m out
    expect(insideCircle({ ...edge, accuracy: 120 }, pending)).toBe(true); // 200 + 100 allowance
    expect(insideCircle({ ...edge, accuracy: 5000 }, pending)).toBe(true); // still capped at 100
    expect(insideCircle({ latitude: 18.504, longitude: 73.8, accuracy: 5000, timestamp: 0 }, pending)).toBe(false); // ~445 m
    expect(insideCircle({ ...edge, accuracy: null }, pending)).toBe(false);
  });
});

describe('reminderTime', () => {
  it('is 30 minutes after opening, never in the past, never past the IST day', () => {
    expect(reminderTime(pending, at(8, 40))?.toISOString()).toBe(at(9, 30).toISOString());
    expect(reminderTime(pending, at(10, 0))?.toISOString()).toBe(new Date(at(10, 0).getTime() + 60_000).toISOString());
    expect(reminderTime({ opensAt: at(23, 45).toISOString() }, at(8, 40))).toBeNull();
    expect(reminderTime({ opensAt: 'nonsense' }, at(8, 40))).toBeNull();
  });
});

describe('backgroundIntervalMinutes', () => {
  it('runs every 15 minutes only while an arrival is waiting', () => {
    expect(backgroundIntervalMinutes(1, 30)).toBe(15);
    expect(backgroundIntervalMinutes(0, 30)).toBe(30);
  });
});

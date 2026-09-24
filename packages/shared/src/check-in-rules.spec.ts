import {
  CheckInArrivalOutcome,
  CheckInTimeSource,
  checkInAllowanceMeters,
  decideCheckInTime,
  usableBranchPoint,
} from './check-in-rules';
import { businessDateKey } from './labels';

describe('checkInAllowanceMeters', () => {
  it('adds the device accuracy (capped at 1 km) and the branch pin accuracy', () => {
    expect(checkInAllowanceMeters({ geofenceMeters: 2000 })).toBe(2000);
    expect(checkInAllowanceMeters({ geofenceMeters: 2000, deviceAccuracyMeters: 50, branchAccuracyMeters: 300 })).toBe(2350);
    expect(checkInAllowanceMeters({ geofenceMeters: 2000, deviceAccuracyMeters: 5000 })).toBe(3000);
    expect(checkInAllowanceMeters({ geofenceMeters: 2000, deviceAccuracyMeters: -5 })).toBe(2000);
  });
});

describe('usableBranchPoint', () => {
  it('treats (0,0), nulls and garbage as no pin', () => {
    expect(usableBranchPoint(0, 0)).toBeNull();
    expect(usableBranchPoint(null, 77)).toBeNull();
    expect(usableBranchPoint('x', 77)).toBeNull();
    expect(usableBranchPoint('12.9', '77.5')).toEqual({ latitude: 12.9, longitude: 77.5 });
  });
});

describe('decideCheckInTime — owner decision 2026-09-24', () => {
  // 11:00 IST: far enough from both midnights that every window below stays on one day.
  const receivedAt = new Date('2026-09-24T11:00:00+05:30');
  const branch = { latitude: 12.9716, longitude: 77.5946 };
  const at = (min: number) => new Date(receivedAt.getTime() - min * 60_000);
  const inside = (min: number, over: any = {}) => ({ latitude: 12.9717, longitude: 77.5947, accuracyMeters: 10, recordedAt: at(min), ...over });
  const base = {
    receivedAt,
    fromAssignedAssayer: true,
    maxAgeHours: 4,
    trailWindowMinutes: 15,
    geofenceMeters: 2000,
    branch,
    fixes: [inside(30)],
    businessDayOf: (d: Date) => businessDateKey(d),
  };

  it('accepts a same-day, recent, corroborated arrival', () => {
    const d = decideCheckInTime({ ...base, arrivedAt: at(40).toISOString() });
    expect(d).toEqual({ checkedInAt: at(40), source: CheckInTimeSource.DEVICE, outcome: CheckInArrivalOutcome.ACCEPTED, claimedArrivalAt: at(40) });
  });

  it('never records a check-in after the server received it (a claim inside the skew is clamped)', () => {
    const claim = new Date(receivedAt.getTime() + 60_000);
    const d = decideCheckInTime({ ...base, arrivedAt: claim.toISOString(), fixes: [inside(-1)] });
    expect(d.source).toBe(CheckInTimeSource.DEVICE);
    expect(d.checkedInAt).toEqual(receivedAt);
    expect(d.claimedArrivalAt).toEqual(claim);
  });

  it.each([
    ['not sent', undefined, CheckInArrivalOutcome.NOT_SENT],
    ['empty', '', CheckInArrivalOutcome.NOT_SENT],
    ['unreadable', 'soon', CheckInArrivalOutcome.UNREADABLE],
    ['a number', 12345, CheckInArrivalOutcome.UNREADABLE],
    ['in the future beyond 2 minutes', new Date(receivedAt.getTime() + 3 * 60_000).toISOString(), CheckInArrivalOutcome.IN_FUTURE],
    ['yesterday', new Date('2026-09-23T23:50:00+05:30').toISOString(), CheckInArrivalOutcome.DIFFERENT_DAY],
    ['older than the maximum', at(5 * 60).toISOString(), CheckInArrivalOutcome.TOO_OLD],
  ])('falls back to server time when the claim is %s', (_label, arrivedAt, outcome) => {
    const d = decideCheckInTime({ ...base, arrivedAt });
    expect(d.source).toBe(CheckInTimeSource.SERVER);
    expect(d.outcome).toBe(outcome);
    expect(d.checkedInAt).toEqual(receivedAt);
  });

  it('marks every office check-in as NOT_FROM_ASSAYER, even one that sent no arrival time (E12)', () => {
    for (const arrivedAt of [undefined, null, '', 'soon']) {
      const d = decideCheckInTime({ ...base, fromAssignedAssayer: false, arrivedAt });
      expect(d.outcome).toBe(CheckInArrivalOutcome.NOT_FROM_ASSAYER);
      expect(d.source).toBe(CheckInTimeSource.SERVER);
      expect(d.checkedInAt).toEqual(receivedAt);
      expect(d.claimedArrivalAt).toBeNull();
    }
  });

  it('falls back when staff sent it on the assayer\'s behalf', () => {
    expect(decideCheckInTime({ ...base, fromAssignedAssayer: false, arrivedAt: at(40).toISOString() }).outcome)
      .toBe(CheckInArrivalOutcome.NOT_FROM_ASSAYER);
  });

  it('falls back when the branch has no pin to test the trail against', () => {
    expect(decideCheckInTime({ ...base, branch: null, arrivedAt: at(40).toISOString() }).outcome)
      .toBe(CheckInArrivalOutcome.NO_BRANCH_LOCATION);
  });

  it.each([
    ['no fixes at all', []],
    ['a fix outside the zone', [inside(40, { latitude: 13.2, longitude: 77.9 })]],
    ['a fix inside the zone but outside the time window', [inside(60)]],
    ['a mocked fix', [inside(40, { isMocked: true })]],
  ])('falls back when the trail has %s', (_label, fixes) => {
    const d = decideCheckInTime({ ...base, fixes, arrivedAt: at(40).toISOString() });
    expect(d.outcome).toBe(CheckInArrivalOutcome.NO_TRAIL_EVIDENCE);
    expect(d.source).toBe(CheckInTimeSource.SERVER);
  });

  it('counts a fix just outside the fence when its own accuracy covers the gap', () => {
    // ~2.3 km from the branch: outside 2000 m, inside 2000 + 500 m accuracy.
    const fix = { latitude: 12.9716, longitude: 77.6158, accuracyMeters: 500, recordedAt: at(40) };
    expect(decideCheckInTime({ ...base, fixes: [fix], arrivedAt: at(40).toISOString() }).outcome).toBe(CheckInArrivalOutcome.ACCEPTED);
    expect(decideCheckInTime({ ...base, fixes: [{ ...fix, accuracyMeters: 10 }], arrivedAt: at(40).toISOString() }).outcome)
      .toBe(CheckInArrivalOutcome.NO_TRAIL_EVIDENCE);
  });
});

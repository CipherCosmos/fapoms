import { AssignmentAction } from '@fapoms/shared';
import { decideArrival, pruneHandled, usableFix, FRESH_FIX_MAX_AGE_MS } from './arrival';
import { MIN_WATCH_RADIUS_M, REGION_LIMIT, planGeofences, type WatchedZone } from './geofence-plan';
import { nextRequest, permissionStep } from './permission-flow';
import { extractPushData, planForPush } from './push-plan';
import { BACKGROUND_REFRESH_EVERY_MS, planBackgroundRun } from './sync-plan';

const now = new Date(2026, 8, 24, 8, 0); // 24 Sep 2026 08:00 local

function job(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    status: 'ACCEPTED' as const,
    scheduledDate: '2026-09-24',
    branchName: `Branch ${id}`,
    bankName: 'SBI',
    capabilities: {
      actions: [{ action: AssignmentAction.CHECK_IN, allowed: true }],
      checkInZone: { latitude: 18.52, longitude: 73.85, radiusMeters: 2000 },
    },
    ...over,
  } as any;
}

describe('planGeofences', () => {
  it('watches today’s and tomorrow’s accepted jobs that the server says can be checked in to', () => {
    const plan = planGeofences([job('a'), job('b', { scheduledDate: '2026-09-25' })], { now, platform: 'android' });
    expect(plan.zones.map((z) => z.assignmentId)).toEqual(['a', 'b']);
    expect(plan.zones[0]).toMatchObject({ label: 'Branch a, SBI', day: '2026-09-24', watchRadius: 2000, serverRadius: 2000, notifyOnExit: false });
  });

  it('watches the server’s arrival circle when it sends one, else the check-in zone', () => {
    const withArrival = job('a', {
      capabilities: {
        actions: [{ action: 'CHECK_IN', allowed: true }],
        checkInZone: { latitude: 18.52, longitude: 73.85, radiusMeters: 2000, arrivalRadiusMeters: 200 },
      },
    });
    const zeroArrival = job('b', {
      capabilities: {
        actions: [{ action: 'CHECK_IN', allowed: true }],
        checkInZone: { latitude: 18.52, longitude: 73.85, radiusMeters: 800, arrivalRadiusMeters: 0 },
      },
    });
    const plan = planGeofences([withArrival, zeroArrival], { now, platform: 'android' });
    expect(plan.zones.map((z) => [z.assignmentId, z.watchRadius, z.serverRadius])).toEqual([
      ['a', 200, 2000],
      ['b', 800, 800],
    ]);
  });

  it('asks the OS for exit events only on circles whose check-in opens later', () => {
    const later = job('o', { capabilities: { actions: [{ action: 'CHECK_IN', allowed: false, opensAt: new Date(2026, 8, 24, 10, 0).toISOString() }], checkInZone: { latitude: 18.5, longitude: 73.8, radiusMeters: 500 } } });
    const plan = planGeofences([job('a'), later], { now, platform: 'android' });
    expect(plan.zones.map((z) => [z.assignmentId, z.notifyOnExit])).toEqual([['a', false], ['o', true]]);
  });

  it('skips jobs that are not accepted, already checked in, removed, or not for today/tomorrow', () => {
    const plan = planGeofences(
      [
        job('pending', { status: 'PENDING' }),
        job('in', { checkedInAt: '2026-09-24T03:00:00Z' }),
        job('gone', { isActive: false }),
        job('later', { scheduledDate: '2026-09-27' }),
        job('past', { scheduledDate: '2026-09-23' }),
      ],
      { now, platform: 'android' },
    );
    expect(plan.zones).toEqual([]);
  });

  it('does not watch anything an older server sent no capabilities for', () => {
    expect(planGeofences([job('a', { capabilities: undefined })], { now, platform: 'ios' }).zones).toEqual([]);
  });

  it('treats a refused CHECK_IN as not watchable — unless only time stands in the way', () => {
    const refused = job('r', { capabilities: { actions: [{ action: 'CHECK_IN', allowed: false, code: 'SUSPENDED' }], checkInZone: { latitude: 18.5, longitude: 73.8, radiusMeters: 500 } } });
    const opensLater = job('o', { capabilities: { actions: [{ action: 'CHECK_IN', allowed: false, opensAt: new Date(2026, 8, 24, 10, 0).toISOString() }], checkInZone: { latitude: 18.5, longitude: 73.8, radiusMeters: 500 } } });
    const opensNextWeek = job('w', { capabilities: { actions: [{ action: 'CHECK_IN', allowed: false, opensAt: new Date(2026, 9, 1).toISOString() }], checkInZone: { latitude: 18.5, longitude: 73.8, radiusMeters: 500 } } });
    const plan = planGeofences([refused, opensLater, opensNextWeek], { now, platform: 'android' });
    expect(plan.zones.map((z) => z.assignmentId)).toEqual(['o']);
    expect(plan.zones[0].opensAt).toBeDefined();
  });

  it('refuses Null Island and nonsense radii, and widens a tiny circle for watching only', () => {
    const plan = planGeofences(
      [
        job('zero', { capabilities: { actions: [{ action: 'CHECK_IN', allowed: true }], checkInZone: { latitude: 0, longitude: 0, radiusMeters: 500 } } }),
        job('neg', { capabilities: { actions: [{ action: 'CHECK_IN', allowed: true }], checkInZone: { latitude: 18, longitude: 73, radiusMeters: -1 } } }),
        job('tiny', { capabilities: { actions: [{ action: 'CHECK_IN', allowed: true }], checkInZone: { latitude: 18, longitude: 73, radiusMeters: 30 } } }),
      ],
      { now, platform: 'android' },
    );
    expect(plan.zones.map((z) => [z.assignmentId, z.watchRadius, z.serverRadius])).toEqual([['tiny', MIN_WATCH_RADIUS_M, 30]]);
  });

  it('keeps the soonest, then the nearest, within the platform cap', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      job(`j${String(i).padStart(2, '0')}`, {
        scheduledDate: i < 25 ? '2026-09-24' : '2026-09-25',
        capabilities: { actions: [{ action: 'CHECK_IN', allowed: true }], checkInZone: { latitude: 18 + i * 0.01, longitude: 73, radiusMeters: 500 } },
      }),
    );
    const ios = planGeofences(many, { now, platform: 'ios', lastPosition: { latitude: 18.2, longitude: 73 } });
    expect(ios.zones).toHaveLength(REGION_LIMIT.ios);
    expect(ios.zones[0].assignmentId).toBe('j20'); // nearest of today's
    expect(ios.zones.every((z) => z.day === '2026-09-24')).toBe(true);
    expect(planGeofences(many, { now, platform: 'android' }).zones).toHaveLength(30);
  });

  it('has a signature that ignores order and labels but not geometry', () => {
    const a = planGeofences([job('a'), job('b')], { now, platform: 'android' });
    const b = planGeofences([job('b', { branchName: 'Renamed' }), job('a')], { now, platform: 'android' });
    expect(a.signature).toBe(b.signature);
    const moved = planGeofences(
      [job('a'), job('b', { capabilities: { actions: [{ action: 'CHECK_IN', allowed: true }], checkInZone: { latitude: 18.6, longitude: 73.85, radiusMeters: 2000 } } })],
      { now, platform: 'android' },
    );
    expect(moved.signature).not.toBe(a.signature);
  });
});

describe('decideArrival', () => {
  const zone: WatchedZone = { assignmentId: 'a', latitude: 18.5, longitude: 73.8, watchRadius: 500, serverRadius: 500, notifyOnExit: false, label: 'X', day: '2026-09-24' };
  const base = { eventType: 'enter' as const, regionId: 'a', zones: [zone], today: '2026-09-24', now, handled: {} };

  it('checks in on entering today’s zone', () => {
    expect(decideArrival(base)).toEqual({ kind: 'check-in', zone });
  });

  it('ignores leaving, unknown regions, other days, repeats and jobs already checked in', () => {
    expect(decideArrival({ ...base, eventType: 'exit' })).toMatchObject({ kind: 'ignore', why: 'exit' });
    expect(decideArrival({ ...base, regionId: 'zz' })).toMatchObject({ why: 'unknown-region' });
    expect(decideArrival({ ...base, zones: [{ ...zone, day: '2026-09-25' }] })).toMatchObject({ why: 'not-today' });
    expect(decideArrival({ ...base, handled: { a: '2026-09-24' } })).toMatchObject({ why: 'already-handled' });
    expect(decideArrival({ ...base, handled: { a: '2026-09-23' } })).toMatchObject({ kind: 'check-in' });
    expect(decideArrival({ ...base, current: { status: 'CHECKED_IN' } })).toMatchObject({ why: 'already-checked-in' });
    expect(decideArrival({ ...base, current: { status: 'ACCEPTED', checkedInAt: 'x' } })).toMatchObject({ why: 'already-checked-in' });
  });

  it('does not send before check-in opens', () => {
    const opensAt = new Date(2026, 8, 24, 9, 0).toISOString();
    expect(decideArrival({ ...base, zones: [{ ...zone, opensAt }] })).toEqual({ kind: 'too-early', zone: { ...zone, opensAt }, opensAt });
    expect(decideArrival({ ...base, zones: [{ ...zone, opensAt }], now: new Date(2026, 8, 24, 9, 1) })).toMatchObject({ kind: 'check-in' });
  });

  it('prunes the handled record to today', () => {
    expect(pruneHandled({ a: '2026-09-23', b: '2026-09-24' }, '2026-09-24')).toEqual({ b: '2026-09-24' });
  });
});

describe('usableFix', () => {
  const t = now.getTime();
  it('uses a fresh, accurate last-known fix', () => {
    const fix = { latitude: 18.5, longitude: 73.8, accuracy: 30, timestamp: t - 10_000 };
    expect(usableFix(fix, t)).toBe(fix);
  });
  it('refuses a stale, vague or missing one', () => {
    expect(usableFix({ latitude: 18.5, longitude: 73.8, accuracy: 30, timestamp: t - FRESH_FIX_MAX_AGE_MS - 1 }, t)).toBeNull();
    expect(usableFix({ latitude: 18.5, longitude: 73.8, accuracy: 900, timestamp: t }, t)).toBeNull();
    expect(usableFix(null, t)).toBeNull();
    expect(usableFix({ latitude: Number.NaN, longitude: 1, timestamp: t }, t)).toBeNull();
  });
});

describe('planBackgroundRun', () => {
  const base = {
    signedIn: true,
    pending: { actions: 0, uploads: 0, fixes: 0 },
    lastRefreshAt: new Date(now.getTime() - 60_000).toISOString(),
    geofencesPlannedFor: '2026-09-24',
    today: '2026-09-24',
    now: now.getTime(),
    canWatchArrivals: true,
  };

  it('does nothing when nothing is waiting and the data is fresh', () => {
    expect(planBackgroundRun(base)).toEqual({
      flushActions: false, flushUploads: false, flushFixes: false, refreshJobs: false, replanGeofences: false, stopEverything: false,
    });
  });

  it('flushes only the queues that have something in them', () => {
    const plan = planBackgroundRun({ ...base, pending: { actions: 1, uploads: 0, fixes: 3 } });
    expect([plan.flushActions, plan.flushUploads, plan.flushFixes]).toEqual([true, false, true]);
  });

  it('refreshes stale data and re-plans the circles', () => {
    const plan = planBackgroundRun({ ...base, lastRefreshAt: new Date(now.getTime() - BACKGROUND_REFRESH_EVERY_MS).toISOString() });
    expect(plan.refreshJobs).toBe(true);
    expect(plan.replanGeofences).toBe(true);
    expect(planBackgroundRun({ ...base, lastRefreshAt: null }).refreshJobs).toBe(true);
  });

  it('re-plans on a new day, but never registers circles without the permission', () => {
    expect(planBackgroundRun({ ...base, geofencesPlannedFor: '2026-09-23' })).toMatchObject({ refreshJobs: true, replanGeofences: true });
    expect(planBackgroundRun({ ...base, geofencesPlannedFor: '2026-09-23', canWatchArrivals: false })).toMatchObject({
      refreshJobs: false,
      replanGeofences: false,
    });
  });

  it('stops everything when nobody is signed in', () => {
    expect(planBackgroundRun({ ...base, signedIn: false, pending: { actions: 5, uploads: 1, fixes: 1 } })).toMatchObject({
      stopEverything: true, flushActions: false, flushUploads: false, flushFixes: false,
    });
  });
});

describe('push payloads', () => {
  it('reads the server’s current FCM data shape', () => {
    const raw = { notificationId: 'n1', type: 'ASSIGNMENT_OFFERED', category: 'ASSIGNMENT', entityType: 'ASSIGNMENT', entityId: 'a1', link: '/assignments/a1', priority: 'HIGH' };
    expect(extractPushData(raw)).toEqual({ type: 'ASSIGNMENT_OFFERED', scope: undefined, category: 'ASSIGNMENT', notificationId: 'n1', assignmentId: 'a1', queryId: undefined, link: '/assignments/a1' });
  });

  it('reads the lean data-only shape, inside expo’s background-task envelope', () => {
    expect(extractPushData({ data: { type: 'QUERY_RAISED', assignmentId: 'a2', queryId: 'q9' } })).toMatchObject({ assignmentId: 'a2', queryId: 'q9' });
    expect(extractPushData({ data: { dataString: JSON.stringify({ type: 'ASSIGNMENT_UPDATED', assignmentId: 'a3' }) } })).toMatchObject({ assignmentId: 'a3' });
    expect(extractPushData({ notification: { request: { content: { data: { entityId: 'a4', link: '' } } } } })).toMatchObject({ assignmentId: 'a4' });
  });

  it('takes the assignment from the link when the id is missing, and a query from its entity type', () => {
    expect(extractPushData({ link: '/assignments/a5?x=1' })).toMatchObject({ assignmentId: 'a5' });
    expect(extractPushData({ entityType: 'VALIDATION_QUERY', entityId: 'q1' })).toMatchObject({ queryId: 'q1', assignmentId: undefined });
  });

  it('returns null for junk', () => {
    expect(extractPushData(null)).toBeNull();
    expect(extractPushData('not json')).toBeNull();
    expect(extractPushData({ foo: 1 })).toBeNull();
  });

  it('refreshes on the server’s silent change push, with or without an assignment', () => {
    const raw = { data: { type: 'refresh', scope: 'assignments', assignmentId: 'a7' } };
    expect(extractPushData(raw)).toMatchObject({ type: 'refresh', scope: 'assignments', assignmentId: 'a7' });
    expect(planForPush(extractPushData(raw))).toEqual({ refreshJobs: true, silent: true, target: { tab: 'Today', assignmentId: 'a7' }, notificationId: undefined });
    expect(planForPush(extractPushData({ type: 'refresh', scope: 'assignments' }))).toMatchObject({ refreshJobs: true, silent: true });
    expect(planForPush({ type: 'refresh', scope: 'something-new' })).toMatchObject({ refreshJobs: true });
  });

  it('maps a push to a refresh and a tap target', () => {
    expect(planForPush({ type: 'ASSIGNMENT_OFFERED', assignmentId: 'a1', notificationId: 'n' })).toEqual({
      notificationId: 'n', refreshJobs: true, target: { tab: 'Today', assignmentId: 'a1' },
    });
    expect(planForPush({ link: '/earnings/statement', type: 'INVOICE_INVITED' })).toMatchObject({ refreshJobs: false, target: { tab: 'Money' } });
    expect(planForPush({ type: 'DOCUMENT_REUPLOAD_REQUESTED' })).toMatchObject({ target: { tab: 'Me' } });
    expect(planForPush({ type: 'ARRIVAL', assignmentId: 'a1' })).toMatchObject({ refreshJobs: false, target: { tab: 'Today', assignmentId: 'a1' } });
    expect(planForPush(null)).toEqual({ refreshJobs: false, target: { tab: 'Today' } });
  });
});

describe('permission flow', () => {
  const f = { foreground: 'undetermined' as const, background: 'undetermined' as const, foregroundCanAskAgain: true, explained: false, hasWatchableJob: true };

  it('is ready once both are granted', () => {
    expect(permissionStep({ ...f, foreground: 'granted', background: 'granted' })).toBe('ready');
  });
  it('explains once, only when there is something to watch', () => {
    expect(permissionStep(f)).toBe('explain');
    expect(permissionStep({ ...f, hasWatchableJob: false })).toBe('quiet');
  });
  it('never asks again by itself after the explanation was shown', () => {
    expect(permissionStep({ ...f, explained: true })).toBe('fallback');
    expect(permissionStep({ ...f, foreground: 'granted', background: 'denied', explained: true })).toBe('fallback');
  });
  it('goes straight to the fallback when the OS will not show its prompt', () => {
    expect(permissionStep({ ...f, foreground: 'denied', foregroundCanAskAgain: false })).toBe('fallback');
  });
  it('asks foreground first, then background', () => {
    expect(nextRequest(f)).toBe('foreground');
    expect(nextRequest({ ...f, foreground: 'granted' })).toBe('background');
    expect(nextRequest({ ...f, foreground: 'granted', background: 'granted' })).toBe('done');
    expect(nextRequest({ ...f, foreground: 'denied', foregroundCanAskAgain: false })).toBe('blocked');
  });
});

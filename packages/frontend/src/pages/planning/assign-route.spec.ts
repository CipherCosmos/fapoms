import { assignRoute, assignBlocker, reassignAndApply, reassignBody, feeToSend, postStopsInOrder, dayPlanStopBody, type LiveAssignment } from './assign-route';

/**
 * Where a planning "assign" goes.
 *
 * `POST /assignments` over a branch's open offer used to MOVE the offer to the new assayer without
 * telling the one who lost it or recording why. The server now refuses that with
 * `BRANCH_HAS_LIVE_OFFER`; moving an offer is `POST /assignments/:id/reassign`, with a reason, and
 * both assayers are told. Every planning entry point (the assign modal's Send to app and Call &
 * Assign, and "Assign anyway") routes through `assignRoute` + `reassignAndApply`, so these tests
 * are the contract for all of them.
 */

const offer = (over: Partial<LiveAssignment> = {}): LiveAssignment => ({
  id: 'asg-1',
  status: 'PENDING',
  proposedFee: 3000,
  scheduledDate: '2026-09-30',
  assayer: { id: 'old-assayer', displayName: 'Asha Rao' },
  ...over,
});

describe('assignRoute', () => {
  it.each(['PENDING', 'ACCEPTED'])('reassigns a %s job held by somebody else', (status) => {
    const r = assignRoute(offer({ status }), 'new-assayer');
    expect(r).toEqual({ kind: 'reassign', assignmentId: 'asg-1', fromName: 'Asha Rao', fromStatus: status });
  });

  it('creates when the branch has no assignment', () => {
    expect(assignRoute(null, 'new-assayer')).toEqual({ kind: 'create' });
    expect(assignRoute(undefined, 'new-assayer')).toEqual({ kind: 'create' });
  });

  it.each(['REJECTED', 'CANCELLED'])('creates over a %s row, as before', (status) => {
    expect(assignRoute(offer({ status }), 'new-assayer')).toEqual({ kind: 'create' });
  });

  it('creates (does not reassign) when it is the same assayer', () => {
    expect(assignRoute(offer(), 'old-assayer')).toEqual({ kind: 'create' });
  });

  it.each(['CHECKED_IN', 'IN_PROGRESS'])('refuses to move a %s job — cancel it instead', (status) => {
    const r = assignRoute(offer({ status }), 'new-assayer');
    expect(r.kind).toBe('blocked');
    expect(r.kind === 'blocked' && r.message).toBe(
      'Asha Rao has already checked in at this branch — cancel the job instead, then plan the branch again.',
    );
  });
});

describe('assignBlocker — the reason is required for a reassignment', () => {
  const reassign = assignRoute(offer(), 'new-assayer');

  it('blocks the button while the reason is empty or blank', () => {
    expect(assignBlocker(reassign, '')).toMatch(/why this branch is moving from Asha Rao/);
    expect(assignBlocker(reassign, '   ')).not.toBeNull();
  });

  it('lets it through once a reason is written', () => {
    expect(assignBlocker(reassign, 'Asha is unwell')).toBeNull();
  });

  it('never asks for a reason on an ordinary create', () => {
    expect(assignBlocker({ kind: 'create' }, '')).toBeNull();
  });

  it('always blocks a checked-in job', () => {
    expect(assignBlocker(assignRoute(offer({ status: 'CHECKED_IN' }), 'x'), 'any reason')).toMatch(/cancel the job instead/);
  });
});

describe('reassignAndApply — ONE request carries the move, fee, date and acceptance', () => {
  const call = (request: jest.Mock) => request.mock.calls.map(([url, opts]) => [
    url, opts?.method, opts?.body ? JSON.parse(opts.body) : undefined,
  ]);

  it('Send to app with an untouched fee: one POST, no proposedFee, no acceptance', async () => {
    const request = jest.fn().mockResolvedValue({ id: 'asg-1', status: 'PENDING', proposedFee: 3200 });
    const out = await reassignAndApply(request, {
      assignmentId: 'asg-1', newAssayerId: 'new-assayer', reason: '  Asha is unwell ',
      scheduledDate: '2026-09-30', acceptOnBehalf: false,
    });
    expect(call(request)).toEqual([
      ['/assignments/asg-1/reassign', 'POST', { newAssayerId: 'new-assayer', reason: 'Asha is unwell', scheduledDate: '2026-09-30' }],
    ]);
    expect(out).toEqual({ status: 'PENDING', proposedFee: 3200 });
  });

  it('Call & Assign with a typed fee: one POST with proposedFee + acceptOnBehalf — no PUT, no /accept', async () => {
    const request = jest.fn().mockResolvedValue({ id: 'asg-1', status: 'ACCEPTED', proposedFee: 3500 });
    const out = await reassignAndApply(request, {
      assignmentId: 'asg-1', newAssayerId: 'new-assayer', reason: 'moved', fee: 3500,
      scheduledDate: '2026-09-30', acceptOnBehalf: true,
    });
    expect(call(request)).toEqual([
      ['/assignments/asg-1/reassign', 'POST', {
        newAssayerId: 'new-assayer', reason: 'moved', proposedFee: 3500, scheduledDate: '2026-09-30',
        acceptOnBehalf: true, acceptanceReason: 'Agreed at ₹3,500 during Call & Assign.',
      }],
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(([, opts]) => opts?.method === 'PUT')).toBe(false);
    expect(request.mock.calls.some(([url]) => String(url).endsWith('/accept'))).toBe(false);
    expect(out.status).toBe('ACCEPTED');
  });

  it('Call & Assign with the fee untouched: accepts without naming a fee, so the server prices the day', () => {
    expect(reassignBody({ assignmentId: 'a', newAssayerId: 'n', reason: 'r', acceptOnBehalf: true })).toEqual({
      newAssayerId: 'n', reason: 'r', acceptOnBehalf: true, acceptanceReason: 'Agreed during Call & Assign.',
    });
  });

  it('never posts to POST /assignments', async () => {
    const request = jest.fn().mockResolvedValue({});
    await reassignAndApply(request, { assignmentId: 'asg-1', newAssayerId: 'n', reason: 'r', acceptOnBehalf: false });
    expect(request.mock.calls.some(([url]) => url === '/assignments')).toBe(false);
  });

  it('refuses to send anything without a reason', async () => {
    const request = jest.fn();
    await expect(reassignAndApply(request, {
      assignmentId: 'asg-1', newAssayerId: 'n', reason: ' ', fee: 1, acceptOnBehalf: false,
    })).rejects.toThrow(/reason is required/);
    expect(request).not.toHaveBeenCalled();
  });

  it('a refusal of the one request is the caller\'s to show — nothing half-done follows it', async () => {
    const request = jest.fn().mockRejectedValue(new Error('REASSIGN_AFTER_CHECK_IN'));
    await expect(reassignAndApply(request, {
      assignmentId: 'asg-1', newAssayerId: 'n', reason: 'r', fee: 3000, acceptOnBehalf: true,
    })).rejects.toThrow('REASSIGN_AFTER_CHECK_IN');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('feeToSend — only a fee the desk typed is sent', () => {
  it('sends nothing while the box still holds the prefilled quote', () => {
    expect(feeToSend('4300', false)).toBeUndefined();
  });

  it('sends the typed figure once the desk edited it', () => {
    expect(feeToSend('3000', true)).toBe(3000);
  });

  it('sends nothing for an edited-then-cleared or non-numeric box', () => {
    expect(feeToSend('', true)).toBeUndefined();
    expect(feeToSend('abc', true)).toBeUndefined();
  });
});

describe('postStopsInOrder — a day plan is posted one stop at a time, in route order', () => {
  it('starts the second post only after the first has resolved', async () => {
    const events: string[] = [];
    const resolvers: Record<string, () => void> = {};
    const post = jest.fn((stop: string) => {
      events.push(`start:${stop}`);
      return new Promise<void>((resolve) => { resolvers[stop] = () => { events.push(`end:${stop}`); resolve(); }; });
    });

    const run = postStopsInOrder(['A', 'B', 'C'], post, () => 'x');
    await Promise.resolve();
    expect(events).toEqual(['start:A']);

    resolvers.A();
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(['start:A', 'end:A', 'start:B']);

    resolvers.B();
    await new Promise((r) => setTimeout(r, 0));
    resolvers.C();
    const results = await run;
    expect(events).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C']);
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
  });

  it('reports a refused stop against that stop, in the given words, and carries on', async () => {
    const post = jest.fn(async (stop: string) => {
      if (stop === 'B') throw new Error('offered');
    });
    const results = await postStopsInOrder(['A', 'B', 'C'], post, () => 'This branch is already offered to an assayer.');
    expect(results).toEqual([
      { stop: 'A', ok: true },
      { stop: 'B', ok: false, error: 'This branch is already offered to an assayer.' },
      { stop: 'C', ok: true },
    ]);
    expect(post).toHaveBeenCalledTimes(3);
  });
});

/**
 * F6/Q10 (2026-09-25): the day plan's whole loop is booked on its FIRST stop, so the booked total
 * equals the plan's total. Other stops send nothing and are priced base-only by the server.
 */
describe('dayPlanStopBody — the loop travels with the first stop only', () => {
  const plan = { totalTravelKm: 184.5, totalTravelMinutes: 212 };

  it('sends the loop on the first stop of the route', () => {
    expect(dayPlanStopBody({ order: 1 }, 1, plan)).toEqual({ plannedDayLoopKm: 184.5, plannedDayLoopMinutes: 212 });
  });

  it('sends nothing on any later stop — and never a fee', () => {
    expect(dayPlanStopBody({ order: 2 }, 1, plan)).toEqual({});
    expect(dayPlanStopBody({ order: 1 }, 1, plan)).not.toHaveProperty('proposedFee');
  });

  it('sends nothing when the plan has no measured travel', () => {
    expect(dayPlanStopBody({ order: 1 }, 1, { totalTravelKm: 0 })).toEqual({});
  });
});

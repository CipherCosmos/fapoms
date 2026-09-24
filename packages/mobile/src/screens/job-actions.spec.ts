import {
  acceptView,
  canClaimExpense,
  canSendReturn,
  checkInView,
  expenseJobChoices,
  preselectExpenseJob,
  shouldOfferCheckOutBeforeReturn,
  todaysOpenJobs,
} from './job-actions';

// 23:30 IST on 24 Sep = 18:00 UTC — still the 24th in India, the 24th in UTC too; and
// 00:30 IST on 25 Sep = 19:00 UTC on the 24th: the IST day is what counts.
const NOW = new Date('2026-09-24T06:00:00Z'); // 11:30 IST, 24 Sep
const LATE_UTC = new Date('2026-09-24T19:00:00Z'); // 00:30 IST, 25 Sep

const job = (over: Record<string, unknown> = {}) => ({
  id: 'j1',
  status: 'ACCEPTED',
  scheduledDate: '2026-09-24T04:30:00.000Z',
  capabilities: undefined,
  checkedInAt: undefined,
  checkedOutAt: undefined,
  ...over,
}) as any;

const caps = (...actions: Array<Record<string, unknown>>) => ({ actions });

describe('check-in', () => {
  it('without server capabilities, is offered only on the job’s own IST day', () => {
    expect(checkInView(job(), NOW)).toEqual({ kind: 'allowed' });
    expect(checkInView(job({ scheduledDate: '2026-09-26T04:30:00.000Z' }), NOW))
      .toEqual({ kind: 'other-day', date: '2026-09-26T04:30:00.000Z' });
    // Past midnight IST the 24th's job is yesterday's, even though UTC still says the 24th.
    expect(checkInView(job(), LATE_UTC).kind).toBe('other-day');
  });

  it('follows the server verdict when it is sent', () => {
    expect(checkInView(job({ scheduledDate: '2026-09-26T04:30:00.000Z', capabilities: caps({ action: 'CHECK_IN', allowed: true }) }), NOW))
      .toEqual({ kind: 'allowed' });
    expect(checkInView(job({ capabilities: caps({ action: 'CHECK_IN', allowed: false, code: 'NOT_SCHEDULED_TODAY', reason: 'r' }) }), NOW).kind)
      .toBe('other-day');
    expect(checkInView(job({ capabilities: caps({ action: 'CHECK_IN', allowed: false, code: 'ASSAYER_NOT_ACTIVE', reason: 'Suspended' }) }), NOW))
      .toEqual({ kind: 'blocked', code: 'ASSAYER_NOT_ACTIVE', reason: 'Suspended' });
  });
});

describe('accept', () => {
  it('is allowed when the server says nothing, and refused with its reason when it says no', () => {
    expect(acceptView(job({ status: 'PENDING' })).allowed).toBe(true);
    expect(acceptView(job({ status: 'PENDING', capabilities: caps({ action: 'ACCEPT', allowed: false, code: 'ASSAYER_ON_LEAVE', reason: 'On leave' }) })))
      .toEqual({ allowed: false, code: 'ASSAYER_ON_LEAVE', reason: 'On leave' });
  });
});

describe('expense claims', () => {
  it('only against a visit under way or done', () => {
    expect(canClaimExpense(job({ status: 'ACCEPTED' }))).toBe(false);
    expect(canClaimExpense(job({ status: 'PENDING' }))).toBe(false);
    for (const status of ['CHECKED_IN', 'IN_PROGRESS', 'COMPLETED']) expect(canClaimExpense(job({ status }))).toBe(true);
  });

  it('respects the server’s CLAIM_EXPENSE refusal (job already on a bill)', () => {
    expect(canClaimExpense(job({ status: 'COMPLETED', capabilities: caps({ action: 'CLAIM_EXPENSE', allowed: false }) }))).toBe(false);
  });

  it('lists claimable jobs newest first and preselects sensibly', () => {
    const a = job({ id: 'a', status: 'COMPLETED', scheduledDate: '2026-09-20T04:30:00Z' });
    const b = job({ id: 'b', status: 'CHECKED_IN', scheduledDate: '2026-09-24T04:30:00Z' });
    const c = job({ id: 'c', status: 'ACCEPTED' });
    const choices = expenseJobChoices([a, b, c]);
    expect(choices.map((x) => x.id)).toEqual(['b', 'a']);
    expect(preselectExpenseJob(choices, a)).toBe('a');
    expect(preselectExpenseJob(choices, c)).toBeNull();
    expect(preselectExpenseJob([b], null)).toBe('b');
  });
});

describe("today's jobs", () => {
  it('lists every open job on today, in-flight first — not just the first', () => {
    const list = [
      job({ id: 'later-today', scheduledDate: '2026-09-24T08:30:00Z' }),
      job({ id: 'tomorrow', scheduledDate: '2026-09-25T04:30:00Z' }),
      job({ id: 'working', status: 'CHECKED_IN', scheduledDate: '2026-09-24T09:30:00Z' }),
      job({ id: 'done', status: 'COMPLETED' }),
      job({ id: 'offer', status: 'PENDING' }),
      job({ id: 'early-today', scheduledDate: '2026-09-24T03:30:00Z' }),
    ];
    expect(todaysOpenJobs(list, NOW).map((j) => j.id)).toEqual(['working', 'early-today', 'later-today']);
  });
});

describe('papers', () => {
  it('asks to check out first only while arrived and not yet left', () => {
    expect(shouldOfferCheckOutBeforeReturn(job({ status: 'CHECKED_IN', checkedInAt: 'x' }))).toBe(true);
    expect(shouldOfferCheckOutBeforeReturn(job({ status: 'CHECKED_IN', checkedInAt: 'x', checkedOutAt: 'y' }))).toBe(false);
    expect(shouldOfferCheckOutBeforeReturn(job({ status: 'ACCEPTED' }))).toBe(false);
  });

  it('offers the return on a reopened accepted job whose day has passed, but not on a future one', () => {
    expect(canSendReturn(job({ status: 'CHECKED_IN' }), NOW)).toBe(true);
    expect(canSendReturn(job({ scheduledDate: '2026-09-20T04:30:00Z' }), NOW)).toBe(true);
    expect(canSendReturn(job(), NOW)).toBe(false);
    expect(canSendReturn(job({ scheduledDate: '2026-09-28T04:30:00Z' }), NOW)).toBe(false);
    expect(canSendReturn(job({ scheduledDate: '2026-09-20T04:30:00Z', capabilities: caps({ action: 'SUBMIT_RETURN', allowed: false }) }), NOW)).toBe(false);
    expect(canSendReturn(job({ status: 'PENDING', scheduledDate: '2026-09-20T04:30:00Z' }), NOW)).toBe(false);
  });
});

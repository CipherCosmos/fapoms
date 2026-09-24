import { AssignmentAction } from '@fapoms/shared';
import { actionsFor, jobStep, partitionToday } from './job-view';

describe('actionsFor', () => {
  it('offers nothing when the server sent no capabilities (older server)', () => {
    expect(actionsFor({})).toEqual([]);
    expect(actionsFor({ capabilities: null })).toEqual([]);
    expect(actionsFor({ capabilities: { actions: [] } })).toEqual([]);
  });

  it('shows only what the server listed, in a stable order, with one main button', () => {
    const views = actionsFor({
      capabilities: {
        actions: [
          { action: AssignmentAction.REPORT_ISSUE, allowed: true },
          { action: AssignmentAction.DECLINE, allowed: true },
          { action: AssignmentAction.ACCEPT, allowed: true },
        ],
      },
    });
    expect(views.map((v) => [v.action, v.weight])).toEqual([
      ['ACCEPT', 'main'],
      ['DECLINE', 'danger'],
      ['REPORT_ISSUE', 'quiet'],
    ]);
  });

  it('keeps a not-allowed action, disabled, with the server reason and opening time', () => {
    const [accept, checkIn] = actionsFor({
      capabilities: {
        actions: [
          { action: AssignmentAction.CHECK_IN, allowed: false, code: 'NOT_SCHEDULED_TODAY', reason: 'This job is for tomorrow.', opensAt: '2026-09-25T00:00:00+05:30' },
          { action: AssignmentAction.ACCEPT, allowed: true },
        ],
      },
    });
    expect(checkIn).toEqual({
      action: 'CHECK_IN',
      allowed: false,
      reason: 'This job is for tomorrow.',
      code: 'NOT_SCHEDULED_TODAY',
      opensAt: '2026-09-25T00:00:00+05:30',
      weight: 'quiet',
      comingSoon: false,
    });
    // The main weight goes to the first ALLOWED action, not to a disabled one.
    expect(accept.weight).toBe('main');
  });

  it('marks actions this app cannot carry out yet as coming soon, never main', () => {
    const views = actionsFor({
      capabilities: {
        actions: [
          { action: AssignmentAction.SUBMIT_RETURN, allowed: true },
          { action: AssignmentAction.CHECK_OUT, allowed: true },
          { action: AssignmentAction.CLAIM_EXPENSE, allowed: true },
          { action: AssignmentAction.REPORT_ISSUE, allowed: true },
        ],
      },
    });
    expect(views.map((v) => [v.action, v.comingSoon])).toEqual([
      ['SUBMIT_RETURN', true],
      ['CHECK_OUT', false],
      ['CLAIM_EXPENSE', true],
      ['REPORT_ISSUE', true],
    ]);
    expect(views.some((v) => v.weight === 'main')).toBe(false);
    const wired = actionsFor({ capabilities: { actions: [{ action: AssignmentAction.ACCEPT, allowed: true }, { action: AssignmentAction.DECLINE, allowed: true }, { action: AssignmentAction.CHECK_IN, allowed: true }] } });
    expect(wired.every((v) => !v.comingSoon)).toBe(true);
  });

  it('does not hide an action this build has never heard of', () => {
    const views = actionsFor({ capabilities: { actions: [{ action: 'SIGN_BILL' as AssignmentAction, allowed: true }] } });
    expect(views.map((v) => v.action)).toEqual(['SIGN_BILL']);
  });

  it('treats a gate without `allowed: true` as not allowed', () => {
    const views = actionsFor({ capabilities: { actions: [{ action: AssignmentAction.CHECK_IN } as never] } });
    expect(views[0].allowed).toBe(false);
  });
});

describe('jobStep', () => {
  it('maps the lifecycle onto Reached → Papers → Done', () => {
    expect(jobStep({ status: 'PENDING' })).toBeNull();
    expect(jobStep({ status: 'ACCEPTED' })).toBe(0);
    expect(jobStep({ status: 'ACCEPTED', checkedInAt: '2026-09-24T04:00:00Z' })).toBe(1);
    expect(jobStep({ status: 'CHECKED_IN' })).toBe(1);
    expect(jobStep({ status: 'IN_PROGRESS' })).toBe(1);
    expect(jobStep({ status: 'COMPLETED' })).toBe(3);
    expect(jobStep({ status: 'CANCELLED' })).toBeNull();
  });
});

describe('partitionToday', () => {
  const now = new Date(2026, 8, 24, 9, 0);
  const job = (id: string, status: string, scheduledDate: string, extra: Record<string, unknown> = {}) =>
    ({ id, status, scheduledDate, ...extra }) as { id: string; status: 'PENDING'; scheduledDate: string; isActive?: boolean; checkedInAt?: string };

  it('puts the job in progress first, then today’s accepted job', () => {
    const p = partitionToday([job('a', 'ACCEPTED', '2026-09-24'), job('b', 'CHECKED_IN', '2026-09-24')], now);
    expect(p.now?.id).toBe('b');
    expect(p.later.map((j) => j.id)).toEqual(['a']);
  });

  it('uses today’s accepted job as "now" when nothing is in progress', () => {
    const p = partitionToday([job('t', 'ACCEPTED', '2026-09-25'), job('a', 'ACCEPTED', '2026-09-24')], now);
    expect(p.now?.id).toBe('a');
    expect(p.later.map((j) => j.id)).toEqual(['t']);
  });

  it('lists offers separately, leaves out closed and removed jobs, keeps an overdue one', () => {
    const p = partitionToday(
      [
        job('o', 'PENDING', '2026-09-26'),
        job('x', 'COMPLETED', '2026-09-24'),
        job('d', 'ACCEPTED', '2026-09-24', { isActive: false }),
        job('m', 'ACCEPTED', '2026-09-20'),
      ],
      now,
    );
    expect(p.offers.map((j) => j.id)).toEqual(['o']);
    expect(p.now).toBeNull();
    expect(p.later.map((j) => j.id)).toEqual(['m']);
  });
});

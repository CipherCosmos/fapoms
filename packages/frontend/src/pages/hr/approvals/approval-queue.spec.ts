import { OnboardingApprovalEventKind as K, OnboardingApprovalStatus as S } from '@fapoms/shared';
import { splitApprovalQueue, waitedFor, waitingSince, type QueuedApproval } from './approval-queue';

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));

/**
 * WHAT THE APPROVER'S LIST PUTS IN EACH PART, and so what the count beside "Approvals" counts.
 *
 * The count is the first group only — decisions waiting on the reader — because it is the number
 * they can bring to zero. Somebody they prepared is not theirs to decide, and somebody waiting on
 * HR is not waiting on them; counting either would be a number that does not go down when they
 * work through the list.
 */
describe('splitting the approval queue for one reader', () => {
  const ME = 'boss-1';
  const HR = 'hr-1';
  const row = (id: string, status: S, events: Array<{ kind: K; byId: string; at: string }>, preparers: string[]): QueuedApproval => ({
    id, round: 1, status, decidedAt: null, preparers,
    events: events.map((e) => ({ ...e, byName: null, text: null })),
    assayerId: `a-${id}`, displayName: `Person ${id}`, assayerCode: null, region: null,
  } as QueuedApproval);

  const sentUp = { kind: K.SUBMITTED, byId: HR, at: '2026-09-20T09:00:00Z' };
  const queue = [
    row('waiting', S.PENDING, [sentUp], [HR]),
    row('asked', S.INFO_REQUESTED, [sentUp, { kind: K.INFO_REQUESTED, byId: ME, at: '2026-09-21T09:00:00Z' }], [HR]),
    row('mine-sent', S.PENDING, [{ ...sentUp, byId: ME }], [ME]),
    row('mine-answered', S.PENDING, [sentUp, { kind: K.ANSWERED, byId: ME, at: '2026-09-22T09:00:00Z' }], [HR, ME]),
  ];

  it('puts a round sent up by somebody else, with nothing asked of HR, in "yours"', () => {
    expect(splitApprovalQueue(queue, ME).yours.map((r) => r.id)).toEqual(['waiting']);
  });

  it('puts a round waiting for HR\'s answer in "waiting on HR", not "yours"', () => {
    expect(splitApprovalQueue(queue, ME).waitingOnHr.map((r) => r.id)).toEqual(['asked']);
  });

  /**
   * The rule the server refuses a decision on — read off the round's own `preparers`, the list the
   * approval panel on the record reads too. Sending somebody up, or answering on them, both count.
   */
  it('puts a round the reader prepared under "somebody else decides", even when it is pending', () => {
    expect(splitApprovalQueue(queue, ME).othersDecide.map((r) => r.id)).toEqual(['mine-sent', 'mine-answered']);
  });

  it('gives the other approver the rounds this reader prepared', () => {
    const other = splitApprovalQueue(queue, 'boss-2');
    expect(other.yours.map((r) => r.id)).toEqual(['waiting', 'mine-sent', 'mine-answered']);
    expect(other.othersDecide).toEqual([]);
  });

  it('puts every row in exactly one part', () => {
    const split = splitApprovalQueue(queue, ME);
    const placed = [...split.yours, ...split.waitingOnHr, ...split.othersDecide].map((r) => r.id).sort();
    expect(placed).toEqual(queue.map((r) => r.id).sort());
  });
});

describe('how long a round has waited', () => {
  const at = (iso: string) => ({ kind: K.SUBMITTED, byId: 'x', byName: null, at: iso, text: null });

  /** The last event is the move that put it where it is — sent up, answered, or asked of HR. */
  it('counts from the last thing that happened on the round', () => {
    expect(waitingSince({ events: [at('2026-09-20T09:00:00Z'), at('2026-09-23T09:00:00Z')] } as never)).toBe('2026-09-23T09:00:00Z');
    expect(waitingSince({ events: [] } as never)).toBeNull();
  });

  it('says it in whole days', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    expect(waitedFor('2026-09-24T08:00:00Z', now)).toBe('today');
    expect(waitedFor('2026-09-23T08:00:00Z', now)).toBe('1 day');
    expect(waitedFor('2026-09-20T08:00:00Z', now)).toBe('4 days');
    expect(waitedFor(null, now)).toBe('—');
  });
});

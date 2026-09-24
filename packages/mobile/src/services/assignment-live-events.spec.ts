import { QUIET_RELOAD_EVENTS, notificationMovesJobs } from './assignment-live-events';

describe('live events that reload the job list', () => {
  it('listens for schedule changes, claim decisions and reassignments', () => {
    for (const e of ['schedule:created', 'schedule:updated', 'expense:decided', 'assignment:reassigned']) {
      expect(QUIET_RELOAD_EVENTS).toContain(e);
    }
  });

  it('keeps the document events the server sends to the assayer', () => {
    for (const e of ['document:received', 'document:uploaded', 'document:status-changed']) {
      expect(QUIET_RELOAD_EVENTS).toContain(e);
    }
  });

  it('does not listen for names the server never emits', () => {
    for (const dead of ['query:resolved', 'document:dispatched', 'assignment:counter-offered', 'billing:created']) {
      expect(QUIET_RELOAD_EVENTS).not.toContain(dead);
    }
  });
});

describe('notifications that mean a job moved', () => {
  it('a job reassigned away reloads the list, whichever field carries the type', () => {
    expect(notificationMovesJobs({ type: 'ASSIGNMENT_REASSIGNED_AWAY' })).toBe(true);
    expect(notificationMovesJobs({ notificationType: 'ASSIGNMENT_REASSIGNED_AWAY' })).toBe(true);
    expect(notificationMovesJobs({ data: { type: 'ASSIGNMENT_REASSIGNED_AWAY' } })).toBe(true);
  });

  it('other notifications do not', () => {
    expect(notificationMovesJobs({ type: 'QUERY_RAISED', category: 'VALIDATION' })).toBe(false);
    expect(notificationMovesJobs(null)).toBe(false);
    expect(notificationMovesJobs('ASSIGNMENT_REASSIGNED_AWAY')).toBe(false);
  });
});

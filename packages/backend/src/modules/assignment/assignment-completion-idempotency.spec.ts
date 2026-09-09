import { AssignmentStatus } from '@fapoms/shared';
import { AssignmentStateMachine } from './assignment.state-machine';

/**
 * One logical completion is one completion, however many requests arrive.
 *
 * Six simultaneous `POST /assignments/:id/complete` calls on one assignment each returned 201,
 * wrote an `ASSIGNMENT_COMPLETED` audit event, advanced `entity_version`, and emitted an outbox
 * event — six of each, for one click. No money moved, because the booking path is defended by a
 * deterministic job id, a read guard and a unique index. But the compliance trail recorded the
 * audit as completed six times, and the event bus saw a six-fold amplification.
 *
 * The compare-and-swap inside the transaction refused a row that had moved to some OTHER status,
 * and let a row that had already reached the TARGET status fall straight through to the write.
 *
 * The rule the fix encodes is the state machine's own: a status that does not list itself as a
 * successor cannot be arrived at twice. COMPLETED, CANCELLED, REJECTED and PENDING declare no
 * self-transition. ACCEPTED, CHECKED_IN and IN_PROGRESS declare one deliberately — a field
 * check-in is retried after a flaky connection and has to be able to update the GPS fix.
 */
describe('assignment completion is idempotent', () => {
  describe('the state machine already answers which commands can repeat', () => {
    it.each([
      AssignmentStatus.COMPLETED,
      AssignmentStatus.CANCELLED,
      AssignmentStatus.REJECTED,
      AssignmentStatus.PENDING,
    ])('%s cannot be arrived at twice', (status) => {
      expect(AssignmentStateMachine.canTransition(status, status)).toBe(false);
    });

    it.each([
      AssignmentStatus.ACCEPTED,
      AssignmentStatus.CHECKED_IN,
      AssignmentStatus.IN_PROGRESS,
    ])('%s may repeat, because a retry has real work to do', (status) => {
      expect(AssignmentStateMachine.canTransition(status, status)).toBe(true);
    });
  });

  /**
   * The shortcut's own logic, stated independently of the service so the conditions can be read.
   *
   * Three things must hold together. The row is already at the target; a rival — not this call —
   * put it there, which the version proves; and the target does not allow itself as a successor.
   * Drop any one and the guard is wrong in a specific way, and each case below says which.
   */
  const alreadyAchieved = (
    lockedStatus: AssignmentStatus,
    targetStatus: AssignmentStatus,
    lockedVersion: number,
    preLockVersion: number,
  ) =>
    lockedStatus === targetStatus
    && lockedVersion !== preLockVersion
    && !AssignmentStateMachine.canTransition(lockedStatus, targetStatus);

  describe('the shortcut fires exactly when a rival already did the work', () => {
    it('fires for a second concurrent completion: row at COMPLETED, version moved on', () => {
      expect(alreadyAchieved(AssignmentStatus.COMPLETED, AssignmentStatus.COMPLETED, 6, 5)).toBe(true);
    });

    it('does not fire for the winner, whose own read is still current', () => {
      // The caller that performs the transition sees the version it read. Firing here would make
      // the one real completion a no-op and nothing would ever be recorded.
      expect(alreadyAchieved(AssignmentStatus.COMPLETED, AssignmentStatus.COMPLETED, 5, 5)).toBe(false);
    });

    it('does not fire when the row moved somewhere else — that is a conflict, not a no-op', () => {
      expect(alreadyAchieved(AssignmentStatus.CANCELLED, AssignmentStatus.COMPLETED, 6, 5)).toBe(false);
    });

    it('does not fire for a repeated check-in, which must still update the GPS fix', () => {
      expect(alreadyAchieved(AssignmentStatus.CHECKED_IN, AssignmentStatus.CHECKED_IN, 6, 5)).toBe(false);
    });

    it('does not fire for a re-accept, which the state machine allows on purpose', () => {
      expect(alreadyAchieved(AssignmentStatus.ACCEPTED, AssignmentStatus.ACCEPTED, 6, 5)).toBe(false);
    });

    it.each([
      [AssignmentStatus.CANCELLED],
      [AssignmentStatus.REJECTED],
    ])('fires for a second concurrent %s, for the same reason as completion', (status) => {
      expect(alreadyAchieved(status, status, 6, 5)).toBe(true);
    });
  });

  /**
   * The version is load-bearing, and this says why in a way a future edit cannot miss.
   *
   * By the time the transaction opens, the state machine has already advanced the entity this
   * call holds to the target status. So the status alone cannot say who put the row there — the
   * caller's own unwritten change looks identical to a rival's committed one. Only the version
   * separates them: a rival that got there first bumped it; an in-memory change did not.
   */
  it('cannot be simplified to a status comparison without breaking the winner', () => {
    const statusOnly = (locked: AssignmentStatus, target: AssignmentStatus) =>
      locked === target && !AssignmentStateMachine.canTransition(locked, target);

    // Both the winner and the losers look the same to a status-only test.
    expect(statusOnly(AssignmentStatus.COMPLETED, AssignmentStatus.COMPLETED)).toBe(true);
    // The version tells them apart.
    expect(alreadyAchieved(AssignmentStatus.COMPLETED, AssignmentStatus.COMPLETED, 5, 5)).toBe(false);
    expect(alreadyAchieved(AssignmentStatus.COMPLETED, AssignmentStatus.COMPLETED, 6, 5)).toBe(true);
  });
});

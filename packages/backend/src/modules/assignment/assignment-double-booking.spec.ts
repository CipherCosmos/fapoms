import { ConflictException } from '@nestjs/common';
import { AssignmentStatus } from '@fapoms/shared';
import {
  DAY_EXCLUSIVE_ASSIGNMENT_STATUSES,
  COMMITTED_ASSIGNMENT_STATUSES,
  IN_FLIGHT_ASSIGNMENT_STATUSES,
} from './assignment-workload';
import {
  ASSIGNMENT_CONSTRAINT_MESSAGES,
  constraintNameOf,
  isUniqueViolation,
  throwMappedUniqueViolation,
} from './assignment-constraint-errors';

/**
 * The application's double-booking rule and the database's must be the same rule.
 *
 * They differed by exactly one status, and on exactly that status the difference was visible to
 * users. `idx_assignments_single_active_assayer_day` is a partial unique index covering PENDING,
 * ACCEPTED, CHECKED_IN and IN_PROGRESS; the service checked `COMMITTED_ASSIGNMENT_STATUSES`,
 * which omits PENDING. So a second PENDING offer for one assayer on one day passed every
 * application check, reached the insert, and came back as a unique violation — in `create()`,
 * one that the catch arm reported as "Branch Busy", which is a different rule about a different
 * table column.
 *
 * The index is the authority and was not weakened. The application was widened to state the same
 * rule first, so the caller gets a message naming the assignment in the way instead of a
 * constraint name. These tests pin the two halves together: if someone edits the index without
 * editing the constant, or the reverse, the first test here fails.
 */
describe('double-booking: application policy and database constraint', () => {
  /**
   * Transcribed from `idx_assignments_single_active_assayer_day` as the migration creates it.
   * This is deliberately a literal and not derived from the constant under test — a test that
   * computes its expectation from the thing it is testing proves nothing.
   */
  const INDEX_PREDICATE_STATUSES = ['PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS'];

  it('states the same statuses the database index enforces', () => {
    expect([...DAY_EXCLUSIVE_ASSIGNMENT_STATUSES].sort()).toEqual([...INDEX_PREDICATE_STATUSES].sort());
  });

  it('includes PENDING, which is what the two layers used to disagree about', () => {
    expect(DAY_EXCLUSIVE_ASSIGNMENT_STATUSES).toContain(AssignmentStatus.PENDING);
    expect(COMMITTED_ASSIGNMENT_STATUSES).not.toContain(AssignmentStatus.PENDING);
  });

  it('keeps day-exclusivity separate from capacity, because they answer different questions', () => {
    // Capacity asks "does this person have room this week"; an unanswered offer is not yet a
    // commitment. Exclusivity asks "is this person's day spoken for"; an unanswered offer is.
    expect(DAY_EXCLUSIVE_ASSIGNMENT_STATUSES).not.toEqual(COMMITTED_ASSIGNMENT_STATUSES);
    expect([...DAY_EXCLUSIVE_ASSIGNMENT_STATUSES].sort()).toEqual([...IN_FLIGHT_ASSIGNMENT_STATUSES].sort());
  });

  it('excludes every terminal status — finished work does not hold a day', () => {
    for (const s of [AssignmentStatus.COMPLETED, AssignmentStatus.REJECTED, AssignmentStatus.CANCELLED]) {
      expect(DAY_EXCLUSIVE_ASSIGNMENT_STATUSES).not.toContain(s);
    }
  });
});

/**
 * A unique violation must be reported as the rule that was actually broken.
 *
 * The `create()` catch arm read `code === '23505' || ... || detail.includes('idx_..._branch')`.
 * The `||` meant the constraint name never had to match, so every unique violation on the
 * assignments path — a duplicate assignment number, a replayed idempotency key, a same-day
 * double booking — was answered "Branch Busy: Another active assignment already exists for this
 * branch." Three different problems, three different fixes, one message that described the first.
 */
describe('assignment unique-violation mapping', () => {
  const err = (constraint: string) => ({ code: '23505', constraint, detail: `Key (x)=(y) already exists.` });

  it('recognises a unique violation from either error shape', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ driverError: { code: '23505' } })).toBe(true);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
  });

  it('reads the constraint name from the driver field when present', () => {
    expect(constraintNameOf(err('idx_assignments_single_active_branch')))
      .toBe('idx_assignments_single_active_branch');
  });

  it('falls back to finding a known name in the message text', () => {
    expect(constraintNameOf({ code: '23505', message: 'duplicate key ... idx_assignments_single_active_assayer_day ...' }))
      .toBe('idx_assignments_single_active_assayer_day');
  });

  it('reports a same-day double booking as a double booking, not as Branch Busy', () => {
    let thrown: any;
    try { throwMappedUniqueViolation(err('idx_assignments_single_active_assayer_day')); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect(thrown.message).toMatch(/double booking/i);
    expect(thrown.message).not.toMatch(/Branch Busy/i);
  });

  it('reports a branch collision as Branch Busy', () => {
    let thrown: any;
    try { throwMappedUniqueViolation(err('idx_assignments_single_active_branch')); } catch (e) { thrown = e; }
    expect(thrown.message).toMatch(/Branch Busy/i);
  });

  it('reports a duplicate assignment number as a numbering collision', () => {
    let thrown: any;
    try { throwMappedUniqueViolation(err('UQ_7c08693fc11883cd6b712a1fed2')); } catch (e) { thrown = e; }
    expect(thrown.message).toMatch(/number collision/i);
  });

  it('rethrows an unrecognised unique violation as itself rather than guessing', () => {
    const unknown = err('some_constraint_this_module_knows_nothing_about');
    expect(() => throwMappedUniqueViolation(unknown)).toThrow();
    let thrown: any;
    try { throwMappedUniqueViolation(unknown); } catch (e) { thrown = e; }
    // Not dressed up as a ConflictException with a borrowed explanation.
    expect(thrown).not.toBeInstanceOf(ConflictException);
    expect(thrown).toBe(unknown);
  });

  it('rethrows a non-unique-violation error untouched', () => {
    const other = { code: '23503', message: 'foreign key violation' };
    let thrown: any;
    try { throwMappedUniqueViolation(other); } catch (e) { thrown = e; }
    expect(thrown).toBe(other);
  });

  it('gives every mapped constraint a message that names its own rule', () => {
    // A guard against a future edit copying one message onto another constraint.
    const messages = Object.values(ASSIGNMENT_CONSTRAINT_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

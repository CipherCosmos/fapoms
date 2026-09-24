import { ConflictException } from '@nestjs/common';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { BypassableRule, BYPASSABLE_RULES } from '@fapoms/shared';
import * as workload from './assignment-workload';
import {
  ASSIGNMENT_CONSTRAINT_MESSAGES,
  constraintNameOf,
  isUniqueViolation,
  throwMappedUniqueViolation,
} from './assignment-constraint-errors';

/**
 * One assayer, several branches on the same day — owner decision 2026-09-24 (E2).
 *
 * The one-job-per-assayer-per-day rule had two halves: the partial unique index
 * `idx_assignments_single_active_assayer_day` and the application's `DAY_EXCLUSIVE_ASSIGNMENT_STATUSES`
 * (checked by `ConstraintEvaluator.checkDoubleBooking`). Both are gone, together — a database that
 * still refused the second branch would turn every allowed plan into a raw unique violation. These
 * pin that the retirement is complete: the index is dropped by a migration, the constant and the
 * suspendable rule no longer exist, and no constraint message still describes the old rule.
 */
describe('several branches per assayer per day', () => {
  const MIGRATIONS_DIR = join(__dirname, '..', '..', 'infrastructure', 'database', 'migrations');

  it('drops idx_assignments_single_active_assayer_day in a migration that runs after the one that created it', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.ts')).sort();
    const creator = files.find((f) => /CREATE UNIQUE INDEX IF NOT EXISTS "idx_assignments_single_active_assayer_day"/
      .test(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').split('public async down')[0]));
    const dropper = files.find((f) => /DROP INDEX IF EXISTS "idx_assignments_single_active_assayer_day"/
      .test(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').split('public async down')[0]));
    expect(creator).toBeDefined();
    expect(dropper).toBeDefined();
    expect(Number(dropper!.split('-')[0])).toBeGreaterThan(Number(creator!.split('-')[0]));
  });

  it('no longer exports a day-exclusive status set', () => {
    expect((workload as Record<string, unknown>).DAY_EXCLUSIVE_ASSIGNMENT_STATUSES).toBeUndefined();
  });

  it('offers no DOUBLE_BOOKING rule to suspend', () => {
    expect(Object.values(BypassableRule)).not.toContain('DOUBLE_BOOKING');
    expect(BYPASSABLE_RULES.map((r) => r.rule)).not.toContain('DOUBLE_BOOKING');
  });

  it('keeps no message for the dropped day index', () => {
    expect(ASSIGNMENT_CONSTRAINT_MESSAGES).not.toHaveProperty('idx_assignments_single_active_assayer_day');
  });
});

/**
 * A unique violation must be reported as the rule that was actually broken.
 *
 * The `create()` catch arm read `code === '23505' || ... || detail.includes('idx_..._branch')`.
 * The `||` meant the constraint name never had to match, so every unique violation on the
 * assignments path — a duplicate assignment number, a replayed idempotency key — was answered "Branch Busy: Another active assignment already exists for this
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
    expect(constraintNameOf({ code: '23505', message: 'duplicate key ... idx_assignments_single_active_branch ...' }))
      .toBe('idx_assignments_single_active_branch');
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

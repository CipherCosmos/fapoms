import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AssayerPayableStatus,
  BillingState,
  DEAD_BILLING_STATES,
  DEAD_PAYABLE_STATUSES,
  isLiveBillingEntry,
  isLivePayable,
  liveBillingEntrySql,
  livePayableSql,
} from '@fapoms/shared';

/**
 * "Is it booked?" must mean "does a live financial effect exist?", never "has a row ever existed?".
 *
 * The defect this pins: an audit was completed (payable + client line booked), reopened (both
 * correctly withdrawn — payable VOIDED, line CANCELLED), redone and completed again. The second
 * completion returned 201 and set `completion_date`, and booked nothing at all, because the
 * existence check found the voided payable and concluded "already booked". The assayer was never
 * paid for the work they redid; the client was never billed for it.
 *
 * Worse, nothing could see it. Five reads shared the same existence test, so the money view said
 * `booked: true` beside a voided payable and the reconciler — which exists to repair exactly this
 * and shares its query with the repair — reported nothing to fix.
 *
 * `billing-engine.service.spec.ts` has a case named "is idempotent: an already-booked assignment
 * writes nothing". It mocks a LIVE row, so it passed throughout and would keep passing after any
 * fix. The half that worked was the half under test.
 */
const SERVICE = join(__dirname, 'billing-engine.service.ts');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('a dead financial row is history, not a booking', () => {
  describe('the rule itself', () => {
    it('counts a voided payable as dead and every other status as live', () => {
      expect(isLivePayable(AssayerPayableStatus.VOIDED)).toBe(false);
      for (const s of [AssayerPayableStatus.PENDING, AssayerPayableStatus.APPROVED, AssayerPayableStatus.PAID]) {
        expect(isLivePayable(s)).toBe(true);
      }
    });

    it('counts a cancelled client line as dead and every other state as live', () => {
      expect(isLiveBillingEntry(BillingState.CANCELLED)).toBe(false);
      for (const s of [BillingState.UNBILLED, BillingState.INVOICED, BillingState.PAID]) {
        expect(isLiveBillingEntry(s)).toBe(true);
      }
    });

    /**
     * A status nobody has classified is live. That is the direction that fails safe: an
     * unclassified state makes the reconciler see the assignment and the index refuse a duplicate,
     * rather than making every check ignore it at once.
     */
    it('treats an unknown status as live rather than silently dead', () => {
      expect(isLivePayable('SOME_FUTURE_STATUS')).toBe(true);
      expect(isLiveBillingEntry('SOME_FUTURE_STATE')).toBe(true);
    });

    it('has nothing live in the dead sets', () => {
      expect(DEAD_PAYABLE_STATUSES).toEqual([AssayerPayableStatus.VOIDED]);
      expect(DEAD_BILLING_STATES).toEqual([BillingState.CANCELLED]);
    });

    /** The SQL and the predicate are built from one enum so a query cannot drift from a check. */
    it('renders the same rule as SQL, for whichever alias the query uses', () => {
      expect(livePayableSql('p')).toBe(`p.status NOT IN ('VOIDED')`);
      expect(liveBillingEntrySql('e')).toBe(`e.state NOT IN ('CANCELLED')`);
      expect(livePayableSql('payable')).toContain('payable.status');
    });
  });

  describe('every read that decides "already booked" applies it', () => {
    const src = stripComments(readFileSync(SERVICE, 'utf8'));

    /**
     * The five reads named in the finding. Each previously joined or looked up by
     * `assignment_id` alone; each must now qualify that with the liveness rule.
     */
    it('joins billing_entries and assayer_payables on liveness wherever it asks whether an assignment is booked', () => {
      /**
       * The predicate is written by `liveBillingEntrySql(...)` / `livePayableSql(...)` rather than
       * spelled out, so accept either the helper call or the literal it produces. Looking only for
       * the literal is how the first version of this test failed against correct code.
       */
      const guarded = String.raw`\s+AND\s+(\$\{live\w+Sql\(|e\.state|p\.status)`;
      const bareEntryJoins =
        src.match(new RegExp(String.raw`LEFT JOIN billing_entries e ON e\.assignment_id = a\.id(?!${guarded})`, 'g')) ?? [];
      const barePayableJoins =
        src.match(new RegExp(
          String.raw`LEFT JOIN assayer_payables p ON p\.assignment_id = a\.id AND p\.expense_id IS NULL(?!${guarded})`, 'g',
        )) ?? [];
      expect({ bareEntryJoins, barePayableJoins }).toEqual({ bareEntryJoins: [], barePayableJoins: [] });
    });

    /**
     * And the guard has to be able to fail. A negative assertion over a regex is worth nothing
     * unless the regex matches the thing it is looking for, so this feeds it a bare join.
     */
    it('would catch a join that lost the liveness predicate', () => {
      const withBareJoin = `
        SELECT a.id FROM assignments a
          LEFT JOIN billing_entries e ON e.assignment_id = a.id
         WHERE a.status = 'COMPLETED'`;
      const guarded = String.raw`\s+AND\s+(\$\{live\w+Sql\(|e\.state|p\.status)`;
      const found =
        withBareJoin.match(new RegExp(String.raw`LEFT JOIN billing_entries e ON e\.assignment_id = a\.id(?!${guarded})`, 'g')) ?? [];
      expect(found).toHaveLength(1);
    });

    it('looks up the booking legs with the dead states excluded', () => {
      expect(src).toContain('state: Not(In(DEAD_BILLING_STATES))');
      expect(src).toContain('status: Not(In(DEAD_PAYABLE_STATUSES))');
    });

    /**
     * The reuse that follows the check. Reusing a dead leg would leave the new completion
     * pointing at withdrawn money — the same defect one line further down.
     */
    it('reuses only a live leg, and inserts when the only row is dead', () => {
      expect(src).toContain('livePayable ?? await this.insertFeePayable');
      expect(src).toContain('liveEntry ?? await this.insertClientLine');
    });

    it('reports booked from the live legs', () => {
      expect(src).toMatch(/booked:\s*!!\(entry && payable\)/);
      expect(src).toContain('isLivePayable(p.status)');
      expect(src).toContain('isLiveBillingEntry(e.state)');
    });
  });

  describe('the uniqueness leaves room for a legitimate redo', () => {
    const migration = readFileSync(
      join(__dirname, '../../infrastructure/database/migrations/1798000000000-LiveMoneyUniquePerAssignment.ts'),
      'utf8',
    );

    /**
     * Filtering the application queries is only half the fix: while the indexes were one-row-per-
     * assignment regardless of status, the replacement row could not be inserted either, so the
     * booking would have failed instead of silently doing nothing. Both halves or neither.
     */
    it('makes both unique indexes partial on the same states the code calls dead', () => {
      expect(migration).toMatch(/UQ_assayer_payables_fee_per_assignment[\s\S]*?status NOT IN \('VOIDED'\)/);
      expect(migration).toMatch(/UQ_billing_entries_root_per_assignment[\s\S]*?state NOT IN \('CANCELLED'\)/);
    });

    /** Same names, so the race handler's `isUniqueViolation(...)` still matches. */
    it('keeps the index names the service matches on', () => {
      const service = readFileSync(SERVICE, 'utf8');
      expect(service).toContain("isUniqueViolation(err, 'UQ_billing_entries_root_per_assignment')");
      expect(service).toContain("isUniqueViolation(err, 'UQ_assayer_payables_fee_per_assignment')");
    });
  });

  /**
   * The aggregates.
   *
   * Fixing the booking path made two rows per assignment the NORMAL outcome of a reopen and redo,
   * which turned a family of latent bugs live: `voidPayable` sets the status and nothing else, so
   * a withdrawn payable keeps its full amounts, stays `is_active`, and has `on_hold` cleared. Any
   * SUM filtering only on those columns counts it at face value.
   */
  describe('every sum over the money tables counts live rows only', () => {
    const src = stripComments(readFileSync(SERVICE, 'utf8'));

    /** The Form 26Q feed. Double-counting here misstates a filing to the tax authority. */
    it('excludes voided payables from the TDS report', () => {
      const i = src.indexOf('HAVING SUM(tds_amount) > 0');
      expect(i).toBeGreaterThan(-1);
      const q = src.slice(Math.max(0, i - 1400), i);
      expect(q).toContain("livePayableSql('assayer_payables')");
    });

    /**
     * `assayerTotals.outstanding` is written into `billing_payments.running_balance` on every
     * outbound disbursement — a stored, immutable figure on a real payment. A voided payable is
     * GUARANTEED to land in it without this, because `voidPayable` clears `on_hold` and that is
     * the only column the clause filters on.
     */
    it('excludes voided payables from what an assayer is owed', () => {
      const i = src.indexOf('async assayerTotals');
      const q = src.slice(i, i + 900);
      expect(q).toContain("andLivePayableSql('p')");
    });

    it('excludes voided payables from cost and margin, as revenue already excludes cancelled', () => {
      expect(src).toContain("SUM(base_amount + travel_amount) FILTER (WHERE ${livePayableSql('assayer_payables')})");
      expect(src).toContain("andLivePayableSql('ap')");
    });

    /** A fee correction belongs to the money owed now, never to money a reopen withdrew. */
    it('reprices the live legs only', () => {
      const i = src.indexOf('async repriceAssignment');
      const q = src.slice(i, i + 1200);
      expect(q).toContain('state: Not(In(DEAD_BILLING_STATES))');
      expect(q).toContain('status: Not(In(DEAD_PAYABLE_STATUSES))');
    });

    /** Otherwise every adjustment and hold on the live line is refused, with no way through. */
    it('edits the live client line', () => {
      const i = src.indexOf('This assignment has no client line yet.');
      const q = src.slice(Math.max(0, i - 700), i);
      expect(q).toContain('state: Not(In(DEAD_BILLING_STATES))');
    });

    /**
     * Voiding a payout must cancel the CURRENT client line. Finding a cancelled one from an
     * earlier completion short-circuits the guard and leaves the live line to ride the next
     * invoice — billing the client for work the business decided not to pay for.
     */
    it('cancels the live client line when a payout is voided', () => {
      const i = src.indexOf('if (saved.assignmentId && !saved.expenseId)');
      const q = src.slice(i, i + 900);
      expect(q).toContain('state: Not(In(DEAD_BILLING_STATES))');
    });
  });

  /**
   * The entity decorators must carry the same predicate as the migration.
   *
   * This repository has learned twice that `synchronize` cannot parse raw migration SQL and treats
   * an index it cannot see as drift — `notification.entity.ts` and `platform-setting.entity.ts`
   * both say so in their own comments. Production refuses to boot with synchronize on, but dev and
   * staging do not: left undeclared, TypeORM would drop these partial indexes and recreate the
   * total ones, silently restoring the defect in the environments where a redo is most likely to
   * be tried.
   */
  describe('the entity metadata matches the migration', () => {
    const payable = readFileSync(join(__dirname, 'payable.entity.ts'), 'utf8');
    const entry = readFileSync(join(__dirname, 'billing-entry.entity.ts'), 'utf8');

    it('declares the fee payable index as partial on the dead status', () => {
      const i = payable.indexOf("@Index('UQ_assayer_payables_fee_per_assignment'");
      const decl = payable.slice(i, i + 260);
      expect(decl).toContain('"expense_id" IS NULL');
      expect(decl).toContain(`"status" NOT IN ('VOIDED')`);
    });

    it('declares the client line index as partial on the dead state', () => {
      const i = entry.indexOf("@Index('UQ_billing_entries_root_per_assignment'");
      const decl = entry.slice(i, i + 220);
      expect(decl).toContain(`"state" NOT IN ('CANCELLED')`);
    });
  });
});

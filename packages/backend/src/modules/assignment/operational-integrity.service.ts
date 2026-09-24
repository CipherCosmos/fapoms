import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DEPARTED_LIFECYCLE_STATES, hasLeftWorkforce } from '@fapoms/shared';
import {
  BRANCH_EXCLUSIVE_ASSIGNMENT_STATUSES,
  IN_FLIGHT_ASSIGNMENT_STATUSES,
  sqlStatusList,
} from './assignment-workload';

/** The departed lifecycle states as a SQL literal list, from the one shared definition. */
const departedSqlList = DEPARTED_LIFECYCLE_STATES.map((s) => `'${s}'`).join(', ');

/**
 * The stated reason for a cancellation, or null when there is none. The state machine writes the
 * placeholder 'Cancelled' when a caller supplied nothing, so that text is treated as no reason.
 */
export function cancellationReasonOf(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.toLowerCase() === 'cancelled') return null;
  return text;
}

export interface IntegrityViolation {
  rule: string;
  severity: 'P0' | 'P1' | 'P2';
  entityId: string;
  details: Record<string, any>;
  description: string;
}

export interface RuleFailure {
  rule: string;
  error: string;
}

export interface IntegrityScanReport {
  timestamp: string;
  /**
   * Rules that ran to completion — NOT the number attempted. A rule whose statement throws is
   * excluded here and named in `failedRules`, so `scannedRules + failedRules.length` is always the
   * number of rules the scanner defines. Read the two together: `totalViolations: 0` only means a
   * clean database when `failedRules` is empty.
   */
  scannedRules: number;
  totalViolations: number;
  summary: Record<string, number>;
  violations: IntegrityViolation[];
  /** Rules that could not be evaluated, with the database error that stopped each one. */
  failedRules: RuleFailure[];
}

@Injectable()
export class OperationalIntegrityService {
  private readonly logger = new Logger(OperationalIntegrityService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Read-only operational invariant scanner for Phase 2 integrity audit.
   * Detects and reports anomalies across workflows without mutating records.
   */
  async scan(): Promise<IntegrityScanReport> {
    const violations: IntegrityViolation[] = [];
    const failedRules: RuleFailure[] = [];
    let answeredRules = 0;

    /**
     * Runs one rule's statement. A failure is still contained to that rule — one broken statement
     * must not deny an auditor the other eight — but it is now recorded under the rule's own id
     * instead of being flattened into an empty result set that reads as "nothing found".
     *
     * The tally is kept here rather than as a rule-count constant so that it cannot drift: a tenth
     * rule counts itself, and a rule that stops running stops being counted, with nothing to
     * remember to update.
     */
    const run = async (rule: string, sql: string): Promise<any[]> => {
      try {
        const rows = await this.dataSource.query(sql);
        answeredRules += 1;
        return rows;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failedRules.push({ rule, error });
        this.logger.error(`Integrity rule ${rule} could not be evaluated: ${error}`);
        return [];
      }
    };

    // (The old rule 1, MULTIPLE_ACTIVE_ASSIGNMENTS_PER_ASSAYER_DAY, is retired: since 2026-09-24 an
    // assayer may hold several branches on one day — owner decision E2. Numbering kept below.)

    // 2. Multiple active assignments for one branch where prohibited
    const branchSlotViolations = await run('MULTIPLE_ACTIVE_ASSIGNMENTS_PER_BRANCH', `
      SELECT project_branch_id, count(*) as count,
             array_agg(id) as assignment_ids, array_agg(assignment_number) as assignment_numbers
      FROM assignments
      WHERE is_active = true
        AND status IN (${sqlStatusList(BRANCH_EXCLUSIVE_ASSIGNMENT_STATUSES)})
        AND project_branch_id IS NOT NULL
      GROUP BY project_branch_id
      HAVING count(*) > 1
    `);

    for (const row of branchSlotViolations) {
      violations.push({
        rule: 'MULTIPLE_ACTIVE_ASSIGNMENTS_PER_BRANCH',
        severity: 'P0',
        entityId: row.project_branch_id,
        details: row,
        description: `Project Branch ${row.project_branch_id} has ${row.count} concurrent active assignments: ${row.assignment_numbers?.join(', ')}`,
      });
    }

    // 3. Cancelled assignment with attendance recorded
    const cancelledWithAttendance = await run('CANCELLED_ASSIGNMENT_WITH_ATTENDANCE', `
      SELECT id, assignment_number, status, checked_in_at, checked_out_at, cancel_reason
      FROM assignments
      WHERE status = 'CANCELLED'
        AND (checked_in_at IS NOT NULL OR checked_out_at IS NOT NULL)
    `);

    /**
     * A cancellation after a real visit (the assayer arrived, the branch then closed or the client
     * withdrew) is an ordinary outcome, not a contradiction — the cancel route requires a reason and
     * stores it in `cancel_reason`. So an EXPLAINED one is reported at P2 (informational: the visit
     * may still be payable, so it stays listed) and only an UNEXPLAINED one is a P1 anomaly. The
     * state machine's own fallback text 'Cancelled' is not an explanation and counts as none.
     */
    for (const row of cancelledWithAttendance) {
      const reason = cancellationReasonOf(row.cancel_reason);
      violations.push({
        rule: 'CANCELLED_ASSIGNMENT_WITH_ATTENDANCE',
        severity: reason ? 'P2' : 'P1',
        entityId: row.id,
        details: row,
        description: `Assignment ${row.assignment_number} is CANCELLED but carries check-in (${row.checked_in_at}) or check-out (${row.checked_out_at}) attendance evidence. `
          + (reason ? `Stated cancellation reason: ${reason}` : 'No cancellation reason is on record.'),
      });
    }

    // 4. Completed assignment without required attendance evidence
    const completedWithoutAttendance = await run('COMPLETED_ASSIGNMENT_WITHOUT_ATTENDANCE', `
      SELECT id, assignment_number, status, completion_date, checked_in_at
      FROM assignments
      WHERE status = 'COMPLETED'
        AND checked_in_at IS NULL
        AND is_active = true
    `);

    for (const row of completedWithoutAttendance) {
      violations.push({
        rule: 'COMPLETED_ASSIGNMENT_WITHOUT_ATTENDANCE',
        severity: 'P1',
        entityId: row.id,
        details: row,
        description: `Assignment ${row.assignment_number} is COMPLETED but has no checked_in_at attendance timestamp on record.`,
      });
    }

    /**
     * 4b. Completed assignment that arrived on site and never left it.
     *
     * The converse of rule 3, and the reason it had to exist: rule 3 has called check-in and
     * check-out "attendance evidence" since it was written, while nothing ever required the
     * departure and the web app never showed it. `checked_out_at` is written in exactly one
     * place — the check-out route — and `CHECKED_IN → COMPLETED` is a legal edge that uploading
     * the audited return takes directly, so the ordinary way to finish a job was the way that
     * lost the record. It is visible in the data: 15 completed audits with an arrival and no
     * departure, against one departure in the whole table.
     *
     * Time on site is the span between the two timestamps, and for a bank collateral audit that
     * span is the evidence. Half a span is not a shorter visit, it is no visit at all.
     *
     * A stated reason does NOT discharge this. `completed_without_check_out_reason` records who
     * said what about the gap; the gap is still a gap, and an auditor asking "which visits have
     * no measurable time on site" must get all of them back, explained or not. The reason rides
     * along in `details` so the answer distinguishes the two without hiding either.
     */
    const completedWithoutCheckOut = await run('COMPLETED_ASSIGNMENT_WITHOUT_CHECK_OUT', `
      SELECT id, assignment_number, status, completion_date, checked_in_at, checked_out_at,
             completed_without_check_out_reason
      FROM assignments
      WHERE status = 'COMPLETED'
        AND checked_in_at IS NOT NULL
        AND checked_out_at IS NULL
        AND is_active = true
    `);

    for (const row of completedWithoutCheckOut) {
      const explained = (row.completed_without_check_out_reason ?? '').trim();
      violations.push({
        rule: 'COMPLETED_ASSIGNMENT_WITHOUT_CHECK_OUT',
        severity: 'P1',
        entityId: row.id,
        details: row,
        description:
          `Assignment ${row.assignment_number} is COMPLETED with a check-in (${row.checked_in_at}) `
          + 'and no check-out, so there is no time on site on record for the visit. '
          + (explained ? `Stated reason: ${explained}` : 'No reason was stated — it predates the requirement.'),
      });
    }

    // 5. Assignment linked to ineligible assayer
    const ineligibleAssayers = await run('ASSIGNMENT_LINKED_TO_INELIGIBLE_ASSAYER', `
      SELECT a.id, a.assignment_number, a.status as assignment_status,
             ass.id as assayer_id, ass.assayer_code, ass.status as assayer_status, ass.is_active as assayer_is_active,
             ass.lifecycle_status as assayer_lifecycle_status, ass.unavailable_reason as assayer_unavailable_reason
      FROM assignments a
      INNER JOIN assayers ass ON a.assayer_id = ass.id
      WHERE a.is_active = true
        AND a.status IN (${sqlStatusList(IN_FLIGHT_ASSIGNMENT_STATUSES)})
        AND (ass.lifecycle_status::text IN (${departedSqlList}, 'INACTIVE') OR ass.is_active = false)
    `);

    /**
     * Only people who have LEFT the workforce (resigned, terminated, archived, or recorded as
     * deceased — `hasLeftWorkforce`, the one shared definition) or whose record was deactivated.
     * ON_LEAVE, SUSPENDED and plain INACTIVE are temporary standings: the job stays theirs and is
     * handled by re-planning, so flagging them as P0 was a false alarm. The SQL pre-filters; the
     * shared rule decides (INACTIVE counts only with the DECEASED reason).
     */
    for (const row of ineligibleAssayers) {
      const departed = hasLeftWorkforce({
        lifecycleStatus: row.assayer_lifecycle_status,
        unavailableReason: row.assayer_unavailable_reason,
      });
      if (!departed && row.assayer_is_active !== false) continue;
      violations.push({
        rule: 'ASSIGNMENT_LINKED_TO_INELIGIBLE_ASSAYER',
        severity: 'P0',
        entityId: row.id,
        details: row,
        description: `Assignment ${row.assignment_number} is assigned to assayer ${row.assayer_code} who has left the workforce or whose record is deactivated (lifecycle '${row.assayer_lifecycle_status}', status '${row.assayer_status}', is_active=${row.assayer_is_active}).`,
      });
    }

    // 6. Assignment with invalid lifecycle combination
    const invalidLifecycle = await run('INVALID_LIFECYCLE_COMBINATION', `
      SELECT id, assignment_number, status, checked_in_at, completion_date
      FROM assignments
      WHERE is_active = true
        AND (
          (status = 'COMPLETED' AND completion_date IS NULL) OR
          (status = 'IN_PROGRESS' AND checked_in_at IS NULL) OR
          (status = 'PENDING' AND checked_in_at IS NOT NULL)
        )
    `);

    for (const row of invalidLifecycle) {
      violations.push({
        rule: 'INVALID_LIFECYCLE_COMBINATION',
        severity: 'P1',
        entityId: row.id,
        details: row,
        description: `Assignment ${row.assignment_number} in status '${row.status}' has incompatible lifecycle markers (checked_in_at=${row.checked_in_at}, completion_date=${row.completion_date}).`,
      });
    }

    // 7. Employment date integrity
    const invalidEmploymentDates = await run('INVALID_EMPLOYMENT_DATES', `
      SELECT id, assayer_code, display_name, joining_date, exit_date
      FROM assayers
      WHERE exit_date IS NOT NULL
        AND joining_date IS NOT NULL
        AND exit_date < joining_date
    `);

    for (const row of invalidEmploymentDates) {
      violations.push({
        rule: 'INVALID_EMPLOYMENT_DATES',
        severity: 'P2',
        entityId: row.id,
        details: row,
        description: `Assayer ${row.assayer_code} (${row.display_name}) has exit_date (${row.exit_date}) earlier than joining_date (${row.joining_date}).`,
      });
    }

    // 8. Active assayer with incomplete onboarding/KYC state
    const incompleteKyAssayers = await run('ACTIVE_ASSAYER_INCOMPLETE_KYC', `
      SELECT id, assayer_code, display_name, pan_number, bank_account_number, ifsc_code
      FROM assayers
      WHERE status = 'ACTIVE'
        AND is_active = true
        AND (
          pan_number IS NULL OR trim(pan_number) = '' OR
          bank_account_number IS NULL OR trim(bank_account_number) = '' OR
          ifsc_code IS NULL OR trim(ifsc_code) = ''
        )
    `);

    for (const row of incompleteKyAssayers) {
      violations.push({
        rule: 'ACTIVE_ASSAYER_INCOMPLETE_KYC',
        severity: 'P2',
        entityId: row.id,
        details: row,
        description: `Active assayer ${row.assayer_code} (${row.display_name}) has incomplete payout KYC details: missing PAN=${!row.pan_number}, Bank=${!row.bank_account_number}, IFSC=${!row.ifsc_code}.`,
      });
    }

    // 9. Stale/orphan workflow records
    const orphanAssignments = await run('STALE_ORPHAN_WORKFLOW_RECORD', `
      SELECT a.id, a.assignment_number, a.status, a.project_branch_id
      FROM assignments a
      LEFT JOIN project_branches pb ON a.project_branch_id = pb.id
      WHERE a.is_active = true
        AND (pb.id IS NULL OR pb.is_active = false)
        AND a.status IN (${sqlStatusList(IN_FLIGHT_ASSIGNMENT_STATUSES)})
    `);

    for (const row of orphanAssignments) {
      violations.push({
        rule: 'STALE_ORPHAN_WORKFLOW_RECORD',
        severity: 'P1',
        entityId: row.id,
        details: row,
        description: `Active assignment ${row.assignment_number} points to an inactive or non-existent project_branch (${row.project_branch_id}).`,
      });
    }

    // Summarize results
    const summary: Record<string, number> = {};
    for (const v of violations) {
      summary[v.rule] = (summary[v.rule] || 0) + 1;
    }

    return {
      timestamp: new Date().toISOString(),
      scannedRules: answeredRules,
      totalViolations: violations.length,
      summary,
      violations,
      failedRules,
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  BRANCH_EXCLUSIVE_ASSIGNMENT_STATUSES,
  DAY_EXCLUSIVE_ASSIGNMENT_STATUSES,
  IN_FLIGHT_ASSIGNMENT_STATUSES,
  sqlStatusList,
} from './assignment-workload';

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

    // 1. Multiple active assignments for one assayer on the same day
    const doubleBookings = await run('MULTIPLE_ACTIVE_ASSIGNMENTS_PER_ASSAYER_DAY', `
      SELECT assayer_id, scheduled_date::text as scheduled_date, count(*) as count,
             array_agg(id) as assignment_ids, array_agg(assignment_number) as assignment_numbers
      FROM assignments
      WHERE is_active = true
        AND status IN (${sqlStatusList(DAY_EXCLUSIVE_ASSIGNMENT_STATUSES)})
        AND scheduled_date IS NOT NULL
        AND assayer_id IS NOT NULL
      GROUP BY assayer_id, scheduled_date
      HAVING count(*) > 1
    `);

    for (const row of doubleBookings) {
      violations.push({
        rule: 'MULTIPLE_ACTIVE_ASSIGNMENTS_PER_ASSAYER_DAY',
        severity: 'P1',
        entityId: row.assayer_id,
        details: row,
        description: `Assayer ${row.assayer_id} has ${row.count} concurrent active assignments on ${row.scheduled_date}: ${row.assignment_numbers?.join(', ')}`,
      });
    }

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

    for (const row of cancelledWithAttendance) {
      violations.push({
        rule: 'CANCELLED_ASSIGNMENT_WITH_ATTENDANCE',
        severity: 'P1',
        entityId: row.id,
        details: row,
        description: `Assignment ${row.assignment_number} is CANCELLED but carries check-in (${row.checked_in_at}) or check-out (${row.checked_out_at}) attendance evidence.`,
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

    // 5. Assignment linked to ineligible assayer
    const ineligibleAssayers = await run('ASSIGNMENT_LINKED_TO_INELIGIBLE_ASSAYER', `
      SELECT a.id, a.assignment_number, a.status as assignment_status,
             ass.id as assayer_id, ass.assayer_code, ass.status as assayer_status, ass.is_active as assayer_is_active
      FROM assignments a
      INNER JOIN assayers ass ON a.assayer_id = ass.id
      WHERE a.is_active = true
        AND a.status IN (${sqlStatusList(IN_FLIGHT_ASSIGNMENT_STATUSES)})
        AND (ass.status != 'ACTIVE' OR ass.is_active = false)
    `);

    for (const row of ineligibleAssayers) {
      violations.push({
        rule: 'ASSIGNMENT_LINKED_TO_INELIGIBLE_ASSAYER',
        severity: 'P0',
        entityId: row.id,
        details: row,
        description: `Assignment ${row.assignment_number} is assigned to assayer ${row.assayer_code} who has status '${row.assayer_status}' (is_active=${row.assayer_is_active}).`,
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

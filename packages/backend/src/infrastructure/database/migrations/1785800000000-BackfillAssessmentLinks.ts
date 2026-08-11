import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Activates the Assessment record, which is modelled but dormant.
 *
 * `AssessmentEntity` and its 18-state lifecycle exist and match the customer spec, but
 * nothing populated them: every assessment sat at PENDING_PLANNING with a null audit_date,
 * only 3 of 10 project-branches had one at all, and no assignment carried an assessment_id.
 *
 * That dead link is what makes document transport structurally impossible:
 *
 *   - `DocumentDispatchWorker.autoDispatch()` selects on `assessment.audit_date` (all null)
 *     and then looks for an ACCEPTED assignment via `assessment_id` (never set), so it can
 *     never dispatch anything even once it is scheduled to run.
 *   - `DocumentService.dispatchDocument()` resolves the assayer to notify through
 *     `assignments.assessment_id`. With it null the lookup returns nothing and the assayer is
 *     never told — documents already sit in DISPATCHED with nobody notified.
 *
 * Idempotent and forward-only. Safe to re-run: every step is guarded so it neither duplicates
 * assessments nor overwrites an assessment that has already advanced past the planning stage.
 *
 * Verified on the dev database 2026-07-31: 7 project-branches without an assessment,
 * 5 assignments unlinked.
 */
export class BackfillAssessmentLinks1785800000000 implements MigrationInterface {
  name = 'BackfillAssessmentLinks1785800000000';

  /**
   * `queryRunner.query()` returns a different shape for INSERT...RETURNING than for
   * UPDATE...RETURNING (rows, versus [rows, affectedCount]). Normalise so the progress
   * logging below reports real numbers — an earlier version silently logged 0 while
   * actually inserting 6 rows.
   */
  private static rowCount(result: unknown): number {
    if (Array.isArray(result)) {
      const [first] = result;
      if (Array.isArray(first)) return first.length;
      return result.length;
    }
    return 0;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Every project-branch gets an Assessment ────────────────────────────────
    // Mirrors the create-if-missing logic already in project.service.ts, for branches that
    // arrived through paths which skip it (seed / alternate import).
    const created = await queryRunner.query(`
      INSERT INTO assessments (project_id, branch_id, zone_id, status, packet_size, version, is_active, created_by, updated_by)
      SELECT pb.project_id, pb.branch_id, b.zone_id, 'PENDING_PLANNING', pb.packet_count, 1, true, 'SYSTEM', 'SYSTEM'
      FROM project_branches pb
      JOIN branches b ON b.id = pb.branch_id
      WHERE NOT EXISTS (
        SELECT 1 FROM assessments a
        WHERE a.project_id = pb.project_id AND a.branch_id = pb.branch_id AND a.is_active = true
      )
      RETURNING id
    `);
    console.log(`[BackfillAssessmentLinks] created ${BackfillAssessmentLinks1785800000000.rowCount(created)} assessment(s)`);

    // ── 2. Link assignments to their assessment ───────────────────────────────────
    // Resolved through project_branch, since assignment carries project_branch_id not branch_id.
    const linked = await queryRunner.query(`
      UPDATE assignments asn
      SET assessment_id = a.id, updated_at = NOW()
      FROM project_branches pb
      JOIN assessments a
        ON a.project_id = pb.project_id AND a.branch_id = pb.branch_id AND a.is_active = true
      WHERE asn.project_branch_id = pb.id
        AND asn.assessment_id IS NULL
      RETURNING asn.assignment_number
    `);
    console.log(`[BackfillAssessmentLinks] linked ${BackfillAssessmentLinks1785800000000.rowCount(linked)} assignment(s)`);

    // ── 3. Populate assessment state from its authoritative assignment ────────────
    // Status mapping is copied verbatim from ASSESSMENT_STATUS_MAP in assignment.service.ts,
    // and the field assignments from syncAssessmentStatus(), so a backfilled row is identical
    // to one the running code would have produced. Diverging here would recreate exactly the
    // duplicate-vocabulary problem this work is meant to remove.
    //
    // Only advances rows still at PENDING_PLANNING, so an assessment that has already moved
    // into the document pipeline is never dragged backwards.
    const advanced = await queryRunner.query(`
      UPDATE assessments a
      SET status = CASE pb.status
            WHEN 'IMPORTED'              THEN 'PENDING_PLANNING'
            WHEN 'PLANNING'              THEN 'PENDING_PLANNING'
            WHEN 'CANDIDATE_SEARCH'      THEN 'ASSESSOR_RECOMMENDED'
            WHEN 'CONTACT_INITIATED'     THEN 'IN_NEGOTIATION'
            WHEN 'NEGOTIATION'           THEN 'IN_NEGOTIATION'
            WHEN 'ASSIGNMENT_CONFIRMED'  THEN 'ASSIGNED_AND_SCHEDULED'
            WHEN 'SCHEDULED'             THEN 'ASSIGNED_AND_SCHEDULED'
            WHEN 'AUDIT_COMPLETED'       THEN 'AUDITED_PDF_RECEIVED'
            WHEN 'VALIDATION_COMPLETED'  THEN 'SENT_TO_DATA_ENTRY'
            WHEN 'CLOSED'                THEN 'COMPLETED'
            WHEN 'UNABLE_TO_COVER'       THEN 'UNASSIGNED'
            WHEN 'ON_HOLD'               THEN 'PENDING_PLANNING'
            WHEN 'CANCELLED'             THEN 'UNASSIGNED'
            ELSE a.status
          END::assessments_status_enum,
          audit_date            = COALESCE(a.audit_date, pb.scheduled_date),
          assigned_assessor_id  = COALESCE(a.assigned_assessor_id, asn.assayer_id),
          agreed_fee            = COALESCE(a.agreed_fee, asn.agreed_fee),
          packet_size           = COALESCE(a.packet_size, pb.packet_count),
          updated_at            = NOW()
      FROM assignments asn
      JOIN project_branches pb ON pb.id = asn.project_branch_id
      WHERE asn.assessment_id = a.id
        AND a.status = 'PENDING_PLANNING'
      RETURNING a.id
    `);
    console.log(`[BackfillAssessmentLinks] advanced ${BackfillAssessmentLinks1785800000000.rowCount(advanced)} assessment(s) out of PENDING_PLANNING`);

    // ── 4. Coverage flag ──────────────────────────────────────────────────────────
    // Spec Phase 4: an assessment is "covered" once an assayer is committed to it.
    await queryRunner.query(`
      UPDATE assessments a
      SET coverage_flag = true, updated_at = NOW()
      FROM assignments asn
      WHERE asn.assessment_id = a.id
        AND a.coverage_flag = false
        AND asn.status IN ('ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED')
    `);
  }

  /**
   * Forward-only. The prior state was "unpopulated", which carries no information worth
   * restoring, and unlinking would re-break document dispatch. Deliberately a no-op.
   */
  public async down(): Promise<void> {
    // no-op — see above
  }
}

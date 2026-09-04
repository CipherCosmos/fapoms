import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every `project_branches` row should have an `assessments` row alongside it — one per
 * `(project_id, branch_id)` pair, created by `ProjectService`'s branch-import path
 * (`project.service.ts`, the `branchIdsWithAssessment` block) the moment a branch is linked to
 * a project. That path is the only writer; nothing else creates one, and nothing backfills it
 * for a project-branch link that was written some other way — a bulk data load straight into
 * `project_branches`, for instance.
 *
 * Found live: a real project with 10 real project-branch links and zero rows in `assessments`.
 * `documents`, `call_logs`, `assignments` and `validation_cases` all carry an (optional)
 * `assessment_id` foreign key, and at least one of those — recording a call outcome
 * (decline / no-answer / callback / wrong number) against an offer — looks it up and fails
 * outright when it is missing: `404 "No assessment exists for project branch …"`, surfaced to
 * nobody, because the screen that triggers it shows no error state for that response.
 *
 * This is the same creation logic `ProjectService` already runs on import, applied once to
 * every `(project_id, branch_id)` pair that does not yet have one. Purely additive — it never
 * touches a row that already exists — so it is safe to run against a database with real,
 * partially-worked assignments already in it.
 */
export class BackfillMissingAssessments1794800000000 implements MigrationInterface {
  name = 'BackfillMissingAssessments1794800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      INSERT INTO assessments (project_id, branch_id, created_by, updated_by, version, is_active)
      SELECT pb.project_id, pb.branch_id, 'migration', 'migration', 1, true
        FROM project_branches pb
       WHERE NOT EXISTS (
         SELECT 1 FROM assessments a
          WHERE a.project_id = pb.project_id AND a.branch_id = pb.branch_id
       )
    `);
  }

  /**
   * Deliberately not reversible.
   *
   * By the time this could run a second time, some of the assessments it created may already be
   * referenced by a document, call log, assignment or validation case saved against them —
   * exactly the records this migration exists to unblock. Deleting them back out would orphan
   * that work, which is a worse state than the one this migration fixes.
   */
  public async down(): Promise<void> {
    // No-op by design; see above.
  }
}

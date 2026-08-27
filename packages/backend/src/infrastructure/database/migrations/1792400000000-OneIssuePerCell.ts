import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One review entry per unreadable cell, however many times the roster is imported.
 *
 * The import appended, so re-importing the same file doubled the queue — 24 entries became 48 on
 * the second run, and a cell somebody had already decided about came back as new work. A cell is
 * identified by where it is, so that is the key.
 *
 * Duplicates already written are collapsed to the oldest, which is the one a resolution would
 * have been recorded against.
 */
export class OneIssuePerCell1792400000000 implements MigrationInterface {
  name = 'OneIssuePerCell1792400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DELETE FROM "assayer_import_issues" a
      USING "assayer_import_issues" b
      WHERE a."source_sheet" = b."source_sheet"
        AND a."source_row" = b."source_row"
        AND a."source_column" = b."source_column"
        AND a."created_at" > b."created_at"
    `);
    await q.query(`
      ALTER TABLE "assayer_import_issues"
        ADD CONSTRAINT "UQ_assayer_import_issue_cell"
        UNIQUE ("source_sheet", "source_row", "source_column")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "assayer_import_issues" DROP CONSTRAINT IF EXISTS "UQ_assayer_import_issue_cell"`);
  }
}

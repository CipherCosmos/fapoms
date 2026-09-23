import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EACH BACKGROUND CHECK KEEPS THE REPORT IT WAS BASED ON.
 *
 * The report used to be one document row whose file list every upload added to, and the checks
 * never said which file was theirs. A candidate who failed, was re-verified and passed would have
 * two reports on that row and two checks beside it, with nothing tying the "not passed" to the
 * report that said so. A check now names its report files, and a file a check rests on cannot be
 * removed.
 *
 * Backfill: every file on a person's report today is given to their LATEST completed check — the
 * only check that could have been read against it, since until now there was only ever one
 * report to look at. Earlier checks keep an empty list: nothing on record says which files were
 * theirs, and guessing would be inventing evidence.
 */
export class BackgroundCheckReportFiles1800100000000 implements MigrationInterface {
  name = 'BackgroundCheckReportFiles1800100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assayer_background_checks" ADD COLUMN IF NOT EXISTS "report_files" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(`
      WITH latest AS (
        SELECT DISTINCT ON (c.assayer_id) c.id, c.assayer_id
          FROM assayer_background_checks c
         WHERE c.is_active AND c.verdict <> 'NOT_CHECKED'
         ORDER BY c.assayer_id, c.checked_on DESC NULLS LAST, c.created_at DESC
      ),
      files AS (
        SELECT l.id AS check_id,
               jsonb_agg(jsonb_build_object(
                 'documentId', d.id,
                 'versionId', v.id,
                 'path', p.path,
                 'uploadedAt', v.uploaded_at
               ) ORDER BY p.ord) AS report_files
          FROM latest l
          JOIN assayer_documents d
            ON d.assayer_id = l.assayer_id AND d.requirement = 'BGV_REPORT' AND d.is_active
          CROSS JOIN LATERAL jsonb_array_elements_text(d.file_paths) WITH ORDINALITY AS p(path, ord)
          LEFT JOIN LATERAL (
            SELECT dv.id, dv.uploaded_at FROM assayer_document_versions dv
             WHERE dv.document_id = d.id AND dv.file_path = p.path
             ORDER BY dv.version DESC LIMIT 1
          ) v ON true
         GROUP BY l.id
      )
      UPDATE assayer_background_checks c
         SET report_files = f.report_files
        FROM files f
       WHERE c.id = f.check_id AND c.report_files = '[]'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayer_background_checks" DROP COLUMN IF EXISTS "report_files"`);
  }
}

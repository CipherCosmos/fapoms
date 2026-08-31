import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The roster's "Link for Document" column gets a home.
 *
 * 472 appraisers on the real file carry a link to the Drive folder holding their scanned
 * paperwork — KYC, letters, photographs collected over years, none of it re-uploaded into this
 * system. The importer read straight past the column, so the only pointer to those documents
 * lived nowhere but the spreadsheet. One nullable text column; the importer fills it and the
 * profile shows it as a link.
 */
export class AssayerDocumentsLink1793600000000 implements MigrationInterface {
  name = 'AssayerDocumentsLink1793600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE assayers ADD COLUMN IF NOT EXISTS documents_link text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE assayers DROP COLUMN IF EXISTS documents_link`);
  }
}

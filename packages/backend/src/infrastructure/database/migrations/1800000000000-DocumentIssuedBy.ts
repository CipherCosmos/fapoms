import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WHO ISSUED A DOCUMENT.
 *
 * A background verification report is produced by an outside agency, and the report is only as
 * good as who produced it — so uploading one now requires naming the agency, and it is kept with
 * the document. Nullable: every document on file today predates it, and most documents (a PAN card,
 * a passbook) have an issuer nobody needs to type.
 */
export class DocumentIssuedBy1800000000000 implements MigrationInterface {
  name = 'DocumentIssuedBy1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayer_documents" ADD COLUMN IF NOT EXISTS "issued_by" varchar(200)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayer_documents" DROP COLUMN IF EXISTS "issued_by"`);
  }
}

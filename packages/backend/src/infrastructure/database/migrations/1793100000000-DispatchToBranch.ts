import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where a document was actually sent.
 *
 * Dispatch had one destination: the assayer, told in-app to open the app and download it. For
 * several clients that is not how it works — the packet goes to the bank branch and the assayer
 * collects it there. Nothing in the record could express that, so a desk following the client's
 * actual process marked the document "dispatched" and then sent it by some other means, leaving
 * the system claiming a delivery it had not made and unable to say where the file went.
 *
 * `dispatched_to_email` is that answer, and null keeps its old meaning exactly: the assayer was
 * notified and downloads it themselves.
 */
export class DispatchToBranch1793100000000 implements MigrationInterface {
  name = 'DispatchToBranch1793100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "documents"
        ADD COLUMN IF NOT EXISTS "dispatched_to_email" character varying(320)
    `);

    /**
     * The branch's own address, so the desk types it once rather than every time.
     *
     * Only 10 of 166 branches have one on file, which is why the dispatch screen asks for it —
     * and why what is typed there is written back here. A column already existed; nothing was
     * filling it.
     */
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_documents_dispatched_to_email"
        ON "documents" ("dispatched_to_email") WHERE "dispatched_to_email" IS NOT NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_documents_dispatched_to_email"`);
    await q.query(`ALTER TABLE "documents" DROP COLUMN IF EXISTS "dispatched_to_email"`);
  }
}

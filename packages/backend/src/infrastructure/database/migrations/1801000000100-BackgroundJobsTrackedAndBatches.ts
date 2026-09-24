import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EVERY UPLOAD AND EVERY BULK RUN, ONE RECORD.
 *
 * Two things `background_jobs` could not yet hold:
 *
 *  - `input_objects` — a job uploaded as SEVERAL files (a day's generated audit packets: up to 100
 *    PDFs in one drop). Each file is stored on its own before the row is written, exactly like the
 *    single `input_object_key`; this is the list of them, `[{ key, fileName, mimeType, size, sha256 }]`.
 *    Null for a single-file or file-less job.
 *
 *  - `runner_queue` — a job that runs on its FEATURE'S own Bull queue (billing's one-at-a-time
 *    money queue, the report export queue, planning, ...) and is only tracked here, so a refreshed
 *    page and the Jobs tray can find it again. Null for a job the foundation's own `tracked-jobs`
 *    queue runs. The recovery sweep reads it to know which queue to ask about the row — and never
 *    re-queues such a row onto `tracked-jobs`, which has no handler for it.
 *
 * Idempotent (IF NOT EXISTS), like the table's own migration.
 */
export class BackgroundJobsTrackedAndBatches1801000000100 implements MigrationInterface {
  name = 'BackgroundJobsTrackedAndBatches1801000000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "input_objects" jsonb`);
    await queryRunner.query(`ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "runner_queue" varchar(64)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "background_jobs" DROP COLUMN IF EXISTS "runner_queue"`);
    await queryRunner.query(`ALTER TABLE "background_jobs" DROP COLUMN IF EXISTS "input_objects"`);
  }
}

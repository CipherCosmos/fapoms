import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * UPLOADS STOP BEING REQUESTS.
 *
 * A 5,000-branch sheet was imported inside the HTTP request that carried it. It took long enough
 * that the browser or a proxy gave up first, and a refresh erased the only thing on screen that
 * said it was happening — so people uploaded again, and two imports raced over the same rows.
 *
 * This table is the durable half of the fix: the request stores the file, writes a row here and
 * answers at once; a worker does the work and writes its progress and result onto the row; every
 * screen (the Jobs tray, the page that started it) reads the row back — after a refresh, a hard
 * refresh or a deploy. See `BackgroundJobsService`.
 *
 * Two of the indexes are rules, not speed:
 *  - `uq_background_jobs_dedupe_open` — the same person uploading the same file for the same thing
 *    while the first is still open gets the first job back, even when the two requests race.
 *  - `uq_background_jobs_exclusive_running` — kinds that must run one at a time (per kind, or per
 *    client) share a key while RUNNING; the database refuses a second, across every worker replica.
 *
 * Idempotent (IF NOT EXISTS throughout), because a migration that cannot be re-run turns a retried
 * deploy into a broken one. Grants to the runtime role come from the migrator's default privileges
 * (see `roles/role-model.ts`), as for every other table.
 */
export class BackgroundJobs1801000000000 implements MigrationInterface {
  name = 'BackgroundJobs1801000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "background_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "kind" varchar(64) NOT NULL,
        "status" varchar(24) NOT NULL DEFAULT 'QUEUED',
        "title" varchar(300) NOT NULL,
        "requested_by" uuid NOT NULL,
        "actor" jsonb NOT NULL,
        "organization_id" uuid,
        "scope_type" varchar(32),
        "scope_id" varchar(64),
        "regions" text[],
        "params" jsonb,
        "progress" jsonb NOT NULL,
        "result" jsonb,
        "result_object_key" text,
        "result_file_name" varchar(255),
        "result_mime_type" varchar(128),
        "error" text,
        "input_object_key" text,
        "input_file_name" varchar(255),
        "input_mime_type" varchar(128),
        "input_sha256" char(64),
        "input_size" bigint,
        "dedupe_key" varchar(128),
        "exclusive_key" varchar(200),
        "parent_job_id" uuid,
        "bull_job_id" varchar(128),
        "attempts" integer NOT NULL DEFAULT 0,
        "cancel_requested_at" timestamptz,
        "cancel_requested_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "started_at" timestamptz,
        "finished_at" timestamptz,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_background_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_background_jobs_parent" FOREIGN KEY ("parent_job_id")
          REFERENCES "background_jobs" ("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_background_jobs_status"
          CHECK ("status" IN ('QUEUED', 'RUNNING', 'AWAITING_REVIEW', 'SUCCEEDED', 'FAILED', 'CANCELLED'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_background_jobs_dedupe_open"
        ON "background_jobs" ("dedupe_key")
        WHERE "status" IN ('QUEUED', 'RUNNING', 'AWAITING_REVIEW') AND "dedupe_key" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_background_jobs_exclusive_running"
        ON "background_jobs" ("exclusive_key")
        WHERE "status" = 'RUNNING' AND "exclusive_key" IS NOT NULL
    `);
    // The Jobs tray's read: one person's jobs, newest first.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_background_jobs_requester"
        ON "background_jobs" ("requested_by", "created_at")
    `);
    // The recovery sweep's read: open rows nobody has touched lately.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_background_jobs_open"
        ON "background_jobs" ("status", "updated_at")
        WHERE "status" IN ('QUEUED', 'RUNNING', 'AWAITING_REVIEW')
    `);
    // The retention sweep's read: finished rows past their window, oldest first.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_background_jobs_finished"
        ON "background_jobs" ("finished_at")
        WHERE "finished_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "background_jobs"`);
  }
}

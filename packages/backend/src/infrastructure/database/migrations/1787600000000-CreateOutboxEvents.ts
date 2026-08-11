import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable domain events.
 *
 * Events were published from memory after COMMIT, so a process that died in that window lost
 * them with no record they were owed. Writing them here inside the same transaction as the
 * business change makes the two atomic; `OutboxRelay` republishes anything the immediate
 * in-process publish did not deliver.
 *
 * The index matches the relay's only query — undispatched rows, oldest first — and mirrors the
 * `@Index(['dispatchedAt','occurredAt'])` on the entity rather than being a raw-SQL-only
 * partial index. A partial index would be narrower, but an index that exists solely in a
 * migration is one `synchronize: true` deletes on the next dev boot, which has already cost
 * this repository a unique index once (see notification.entity.ts).
 */
export class CreateOutboxEvents1787600000000 implements MigrationInterface {
  name = 'CreateOutboxEvents1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "outbox_events" (
        "id" uuid NOT NULL,
        "event_name" character varying(200) NOT NULL,
        "payload" jsonb NOT NULL,
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "dispatched_at" TIMESTAMP WITH TIME ZONE,
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        CONSTRAINT "PK_outbox_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_outbox_events_dispatched_occurred"
        ON "outbox_events" ("dispatched_at", "occurred_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_outbox_events_dispatched_occurred"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "outbox_events"`);
  }
}

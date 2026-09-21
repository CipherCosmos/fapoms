import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EMAILS LEAVE THE REQUEST.
 *
 * Invites, setup links, approval and rejection letters and bulk credentials were sent inside the
 * HTTP request that asked for them. One invite cost ~5 s of the desk's time; a bulk credential run
 * over 540 people held one request for about half an hour, long after the browser had abandoned it
 * at 30 s — so the screen reported a failure while the server kept rotating passwords, and pressing
 * the button again rotated them a second time.
 *
 * This table is the durable half of the queue: the request writes a row and returns, a worker sends
 * it, and the row is where the answer lands. See `OutboundEmailEntity` for why the message body is
 * encrypted and erased once the row settles.
 */
export class OutboundEmails1799300000000 implements MigrationInterface {
  name = 'OutboundEmails1799300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "outbound_emails" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "kind" varchar(48) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'QUEUED',
        "recipient" varchar(320) NOT NULL,
        "subject" varchar(500) NOT NULL,
        "payload" text,
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "entity_type" varchar(64),
        "entity_id" varchar(64),
        "requested_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "sent_at" timestamptz,
        "failed_at" timestamptz,
        CONSTRAINT "PK_outbound_emails" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_outbound_emails_status"
          CHECK ("status" IN ('QUEUED', 'SENDING', 'SENT', 'FAILED'))
      )
    `);
    // The sweeper's only question: what is still owed, oldest first.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbound_emails_unsettled"
        ON "outbound_emails" ("status", "created_at")
        WHERE "status" IN ('QUEUED', 'SENDING')
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbound_emails_entity"
        ON "outbound_emails" ("entity_type", "entity_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "outbound_emails"`);
  }
}

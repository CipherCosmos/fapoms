import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the superseded `communications` module.
 *
 * Two things took over its jobs and did so completely: contact records became `call_logs`
 * (written by Call & Assign, carrying the outcome and the negotiated fee), and email send
 * records became `notifications.email_status` / `emailed_at` / `email_failure_reason`. What was
 * left had **zero rows**, no writer anywhere in the backend outside its own module, and no
 * caller in the web or mobile app — while still exposing two live, permissioned HTTP routes.
 *
 * That combination is the dangerous kind: a reader asking "how does this system record contact
 * with an assayer?" could find this first, wire to it, and produce writes nothing reads.
 *
 * Guarded twice over. The table is dropped ONLY if it is empty, because tidying a schema is
 * never worth destroying someone's history — if any environment turns out to hold rows, this is
 * a no-op there and the data survives for whoever needs to look at it.
 */
export class RemoveSupersededCommunicationsModule1789900000000 implements MigrationInterface {
  name = 'RemoveSupersededCommunicationsModule1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE row_count bigint;
      BEGIN
        IF to_regclass('public.communications') IS NULL THEN
          RETURN;
        END IF;

        EXECUTE 'SELECT count(*) FROM communications' INTO row_count;
        IF row_count = 0 THEN
          DROP TABLE communications;
        ELSE
          RAISE NOTICE
            'communications kept: % row(s) present. The module is gone; the data is not.',
            row_count;
        END IF;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Deliberately not recreated. The module that read this table no longer exists, so an empty
    // table would be a shape with nothing behind it — the exact confusion this removes. Rolling
    // back the code restores the entity, and `synchronize` or a forward migration would recreate
    // the table if it were ever genuinely wanted again.
  }
}

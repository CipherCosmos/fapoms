import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CLOSE THE ONE DOOR THE APPEND-ONLY TRIGGERS LEFT OPEN.
 *
 * ## Why this exists
 *
 * `audit_events` and `audit_chain` are protected by `BEFORE DELETE OR UPDATE ... FOR EACH ROW`
 * triggers. Those refuse every row-level mutation, and they work: `DELETE`, `UPDATE` of a field,
 * and `UPDATE` of the hash column were all verified refused.
 *
 * `TRUNCATE` is not a row-level operation. Postgres fires row triggers per row, and TRUNCATE
 * removes rows without visiting them, so a `FOR EACH ROW` trigger never runs. Discovered during
 * certification by trying it: `TRUNCATE audit_events` returned `TRUNCATE TABLE` and erased 5,621
 * rows in one statement, against a table whose entire purpose is that its contents cannot be
 * erased.
 *
 * The privilege needed is table ownership, which the application's own database role has — the
 * same role the API connects as. So the guarantee was defeatable by anything holding the
 * application's credentials, which is a much lower bar than it sounds: it is the bar the
 * append-only design exists to raise.
 *
 * A statement-level `BEFORE TRUNCATE` trigger is the matching control, and it is the only trigger
 * event that fires for TRUNCATE. It must be `FOR EACH STATEMENT` — `FOR EACH ROW` is rejected for
 * TRUNCATE triggers, which is precisely why the original pair missed it.
 *
 * ## What this does not protect against
 *
 * A superuser can still `ALTER TABLE ... DISABLE TRIGGER` or `DROP TRIGGER`, and `DROP TABLE`
 * removes the trigger with the table. That is unavoidable inside one database: a role that can
 * redefine the schema can undo any in-database control. Real tamper-evidence for that threat is
 * the hash chain plus off-box shipping, not a trigger.
 *
 * Worth recording that the chain did its job here. After the truncate, `audit_chain` still held
 * 4,754 rows whose `audit_event_id` referenced events that no longer existed — so the deletion
 * was detectable immediately and unambiguously, even though it was not prevented. Detection
 * without prevention is a weaker guarantee than the design intended, but it is not nothing.
 */
export class AuditTruncateProtection1796900000000 implements MigrationInterface {
  name = 'AuditTruncateProtection1796900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_reject_truncate() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only: TRUNCATE is not permitted on this table', TG_TABLE_NAME
          USING HINT = 'The audit trail cannot be erased. If you are resetting a certification or '
                       'development database, drop and recreate it from migrations instead.';
      END;
      $$ LANGUAGE plpgsql;
    `);

    // FOR EACH STATEMENT, not FOR EACH ROW: Postgres rejects a row-level TRUNCATE trigger, and
    // that restriction is exactly how the original pair came to miss this event.
    for (const table of ['audit_events', 'audit_chain']) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS ${table}_no_truncate ON ${table}`);
      await queryRunner.query(`
        CREATE TRIGGER ${table}_no_truncate
        BEFORE TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION audit_reject_truncate()
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS audit_chain_no_truncate ON audit_chain`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS audit_reject_truncate()`);
  }
}

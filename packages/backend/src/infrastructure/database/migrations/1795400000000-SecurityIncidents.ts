import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The security-incident register — the workflow behind the CERT-In 6-hour and DPDP 72-hour clocks.
 *
 * Deadlines are computed on read from `detected_at`, so nothing here stores them; the reporting
 * milestones (CERT-In reported, Board notified, principals notified) are nullable timestamps set as
 * they are reached. Indexed by status and detection time for the register's listing and health count.
 */
export class SecurityIncidents1795400000000 implements MigrationInterface {
  name = 'SecurityIncidents1795400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "security_incidents" (
        "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "title"                    varchar(200) NOT NULL,
        "category"                 varchar(32) NOT NULL,
        "severity"                 varchar(16) NOT NULL,
        "status"                   varchar(24) NOT NULL DEFAULT 'OPEN',
        "description"              text,
        "detected_at"              timestamptz NOT NULL,
        "personal_data_involved"   boolean NOT NULL DEFAULT false,
        "affected_data_principals" integer,
        "cert_in_reported_at"      timestamptz,
        "board_notified_at"        timestamptz,
        "principals_notified_at"   timestamptz,
        "remediation"              text,
        "created_by"               uuid,
        "resolved_at"              timestamptz,
        "created_at"               timestamptz NOT NULL DEFAULT now(),
        "updated_at"               timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_security_incidents_status" ON "security_incidents" ("status");`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_security_incidents_detected" ON "security_incidents" ("detected_at");`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_security_incidents_detected";`);
    await q.query(`DROP INDEX IF EXISTS "IDX_security_incidents_status";`);
    await q.query(`DROP TABLE IF EXISTS "security_incidents";`);
  }
}

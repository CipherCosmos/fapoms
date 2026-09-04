import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-factor authentication (TOTP first). Opt-in: a user with no row here logs in exactly as
 * before, so shipping this breaks nobody. `secret_encrypted` holds the TOTP shared secret through
 * the same field-encryption envelope as PAN/bank data — never plaintext at rest. `confirmed_at`
 * is null until the user proves one code (enrol-confirm-before-activate), so a half-finished
 * enrolment never gates login. Per-account MFA attempt lockout lives on the row.
 *
 * Recovery codes are single-use and stored only as SHA-256 hashes (the plaintext is shown once at
 * generation and never persisted).
 */
export class UserMfa1795600000000 implements MigrationInterface {
  name = 'UserMfa1795600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "user_mfa" (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"          uuid NOT NULL,
        "type"             varchar(16) NOT NULL DEFAULT 'TOTP',
        "secret_encrypted" text NOT NULL,
        "confirmed_at"     timestamptz,
        "failed_attempts"  integer NOT NULL DEFAULT 0,
        "locked_until"     timestamptz,
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "updated_at"       timestamptz NOT NULL DEFAULT now()
      )
    `);
    // One enrolment per (user, factor type).
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_mfa_user_type" ON "user_mfa" ("user_id", "type")`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "mfa_recovery_codes" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"    uuid NOT NULL,
        "code_hash"  varchar(64) NOT NULL,
        "used_at"    timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_mfa_recovery_user" ON "mfa_recovery_codes" ("user_id")`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_mfa_recovery_hash" ON "mfa_recovery_codes" ("code_hash")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "mfa_recovery_codes"`);
    await q.query(`DROP TABLE IF EXISTS "user_mfa"`);
  }
}

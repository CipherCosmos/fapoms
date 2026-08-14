import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Operator-owned platform configuration.
 *
 * Business policy — what an unpriced audit is worth, when the morning brief goes out, which
 * mailbox sends it, how long movement records are kept — was spread across environment
 * variables and compiled-in constants, so changing any of it meant editing a file and
 * restarting a process. None of those are engineering decisions.
 *
 * Only *saved* values live here. A key nobody has touched has no row and resolves from the
 * environment or the shipped default instead, which is what makes this safe to add to a
 * running system: every deployment keeps behaving exactly as it does today until somebody
 * deliberately saves something.
 *
 * Secrets (mail passwords) are stored as ciphertext from `encryptField`, and the service
 * refuses to save one at all unless `PII_ENCRYPTION_KEY` is configured — a credential readable
 * in a database that gets backed up and copied is worse than one that stays in the environment.
 */
export class PlatformSettings1789600000000 implements MigrationInterface {
  name = 'PlatformSettings1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform_settings" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_by" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" character varying,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version"    integer NOT NULL DEFAULT 1,
        "is_active"  boolean NOT NULL DEFAULT true,
        "key"        character varying(100) NOT NULL,
        "value"      jsonb,
        "is_secret"  boolean NOT NULL DEFAULT false
      )
    `);

    // One row per key — the resolver reads them into a map, and a second row for the same key
    // would win or lose by insertion order. Declared on the entity too: synchronize rebuilds
    // tables from the entity class and drops migration-only indexes.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_platform_settings_key"
      ON "platform_settings" ("key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "platform_settings"`);
  }
}

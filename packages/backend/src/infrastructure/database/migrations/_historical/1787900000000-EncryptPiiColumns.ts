import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens the sensitive-PII columns so they can hold AES-256-GCM ciphertext (see
 * `infrastructure/security/field-encryption.ts`). The values themselves are encrypted by the entity
 * transformer on write; this migration only makes room (`varchar(n)` → `text`, since a ~10-char PAN
 * becomes an ~80-char `enc:v1:…` string).
 *
 * Rollout is gradual and safe:
 * - Existing rows stay plaintext and remain readable (the transformer passes through any value without
 *   the `enc:v1:` prefix), so nothing breaks the moment this ships.
 * - Every subsequent write re-stores the value encrypted, so data migrates as it is touched.
 * - To encrypt everything at once, run a one-off backfill with `PII_ENCRYPTION_KEY` set that re-saves
 *   each assayer and government-document row through the ORM (which re-encrypts on save). Do that in a
 *   maintenance window after confirming the key is configured.
 *
 * `down` is intentionally a no-op: shrinking back to `varchar(20/50)` would truncate encrypted values,
 * and this is a one-way security hardening. To reverse, decrypt first, then alter the type by hand.
 */
export class EncryptPiiColumns1787900000000 implements MigrationInterface {
  name = 'EncryptPiiColumns1787900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "pan_number" TYPE text`);
    await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "bank_account_number" TYPE text`);
    await queryRunner.query(
      `ALTER TABLE "assayer_government_documents" ALTER COLUMN "document_number" TYPE text`,
    );
  }

  public async down(): Promise<void> {
    // No-op: see the class comment. Reverting the type on encrypted data would truncate it.
  }
}

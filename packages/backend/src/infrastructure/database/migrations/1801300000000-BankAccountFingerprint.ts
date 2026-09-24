import { MigrationInterface, QueryRunner } from 'typeorm';
import { decryptField, bankAccountFingerprint } from '../../security/field-encryption';

/**
 * Let a payout approval ask whether its bank account is on another assayer's record.
 *
 * The owner's decision (2026-09-24 audit, F3): approving a payout — at the office, and again at the
 * HOD — is REFUSED when the account number and IFSC it would be paid to are also on another
 * assayer's record. `bank_account_number` is encrypted with a random IV per value, so SQL equality
 * on it matches nothing once a key is configured; the only way to ask was to decrypt the whole
 * roster on every approval. This adds the same keyed fingerprint `pan_fingerprint` already is
 * (`IdentifierFingerprints1798600000000`), of the normalised account number, with a partial index.
 *
 * NOT unique, for the same reason as the PAN one: two records genuinely share an account today
 * (the data-integrity scan reports them), and a constraint would refuse a legitimate edit. The
 * approval decides, with a message that says which way out there is.
 *
 * The backfill decrypts in TypeScript, and degrades honestly: with no key configured the
 * fingerprint is null and the approval check falls back to comparing the (then plaintext) column.
 */
export class BankAccountFingerprint1801300000000 implements MigrationInterface {
  name = 'BankAccountFingerprint1801300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assayers" ADD COLUMN IF NOT EXISTS "bank_account_fingerprint" character varying(64)`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assayers_bank_account_fingerprint"
        ON "assayers" ("bank_account_fingerprint") WHERE "bank_account_fingerprint" IS NOT NULL
    `);

    const rows: Array<{ id: string; bank_account_number: string | null }> = await queryRunner.query(`
      SELECT "id", "bank_account_number"
        FROM "assayers"
       WHERE "bank_account_number" IS NOT NULL AND "bank_account_number" <> ''
         AND "bank_account_fingerprint" IS NULL
    `);

    let filled = 0;
    for (const row of rows) {
      let fp: string | null = null;
      try {
        fp = bankAccountFingerprint(decryptField(row.bank_account_number as string));
      } catch {
        // Encrypted under a key this process does not hold: left unfingerprinted ("not comparable"),
        // never given a wrong digest.
        continue;
      }
      if (!fp) continue;
      await queryRunner.query(`UPDATE "assayers" SET "bank_account_fingerprint" = $2 WHERE "id" = $1`, [row.id, fp]);
      filled += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`[BankAccountFingerprint] fingerprinted ${filled} of ${rows.length} row(s) holding a bank account.`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assayers_bank_account_fingerprint"`);
    await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "bank_account_fingerprint"`);
  }
}

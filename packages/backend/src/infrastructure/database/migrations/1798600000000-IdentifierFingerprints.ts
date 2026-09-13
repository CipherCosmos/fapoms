import { MigrationInterface, QueryRunner } from 'typeorm';
import { decryptField, fieldFingerprint } from '../../security/field-encryption';

/**
 * Make the duplicate check able to see a PAN.
 *
 * `pan_number` and `aadhaar_number` are encrypted with a fresh random IV per call, so the same PAN
 * encrypts to different ciphertext every time. `WHERE pan_number = :pan` therefore matched nothing,
 * on any deployment with a key configured — while `AssayerService.create` carried a
 * `DEFINITE_DUPLICATE: An assayer with PAN … already exists` branch that read, to anybody auditing
 * it, like a working control. The identifier-check endpoint documents the same limitation honestly;
 * the create path did not.
 *
 * The ciphertext is untouched. A keyed fingerprint of the normalised plaintext sits beside it, and
 * equality on that is the whole of what the roster needs: is this person already here. There is no
 * ordering, no prefix search and no way back to the value — and the key is derived from
 * `PII_ENCRYPTION_KEY`, so the fingerprint cannot be computed by anybody who could not already
 * decrypt the column.
 *
 * NOT a unique index. Two people genuinely share a PAN often enough in this data — a proprietor and
 * their firm, a re-registration after a resignation — that a constraint would refuse legitimate
 * rows at 3am. The duplicate classifier decides, with a reason and an override, which is where that
 * judgement belongs.
 *
 * The backfill runs in TypeScript rather than SQL because decrypting is the only way to read the
 * existing values, and it degrades honestly: with no key configured, `fieldFingerprint` returns
 * null and every row is left as it is, which is the same behaviour that deployment already had.
 */
export class IdentifierFingerprints1798600000000 implements MigrationInterface {
  name = 'IdentifierFingerprints1798600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayers"
        ADD COLUMN IF NOT EXISTS "pan_fingerprint" character varying(64),
        ADD COLUMN IF NOT EXISTS "aadhaar_fingerprint" character varying(64)
    `);

    // Partial: the overwhelming majority of a roster has neither, and an index over nulls is a
    // scan waiting to happen on the one query that must stay fast — the check on every create.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assayers_pan_fingerprint"
        ON "assayers" ("pan_fingerprint") WHERE "pan_fingerprint" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assayers_aadhaar_fingerprint"
        ON "assayers" ("aadhaar_fingerprint") WHERE "aadhaar_fingerprint" IS NOT NULL
    `);

    const rows: Array<{ id: string; pan_number: string | null; aadhaar_number: string | null }> =
      await queryRunner.query(`
        SELECT "id", "pan_number", "aadhaar_number"
          FROM "assayers"
         WHERE ("pan_number" IS NOT NULL AND "pan_number" <> '')
            OR ("aadhaar_number" IS NOT NULL AND "aadhaar_number" <> '')
      `);

    let filled = 0;
    for (const row of rows) {
      // One unreadable row must not stop the deploy. A value encrypted under a key this process
      // does not hold is left without a fingerprint, which reads downstream as "not comparable"
      // rather than as "matches nothing", because the column is null rather than a wrong digest.
      let pan: string | null = null;
      let aadhaar: string | null = null;
      try {
        pan = row.pan_number ? fieldFingerprint(decryptField(row.pan_number)) : null;
        aadhaar = row.aadhaar_number ? fieldFingerprint(decryptField(row.aadhaar_number)) : null;
      } catch {
        continue;
      }
      if (!pan && !aadhaar) continue;

      await queryRunner.query(
        `UPDATE "assayers" SET "pan_fingerprint" = $2, "aadhaar_fingerprint" = $3 WHERE "id" = $1`,
        [row.id, pan, aadhaar],
      );
      filled += 1;
    }

    // eslint-disable-next-line no-console
    console.log(`[IdentifierFingerprints] fingerprinted ${filled} of ${rows.length} row(s) holding an identifier.`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assayers_aadhaar_fingerprint"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assayers_pan_fingerprint"`);
    await queryRunner.query(`
      ALTER TABLE "assayers"
        DROP COLUMN IF EXISTS "aadhaar_fingerprint",
        DROP COLUMN IF EXISTS "pan_fingerprint"
    `);
  }
}

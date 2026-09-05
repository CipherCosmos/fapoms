import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Somewhere to write down what the identity document actually says.
 *
 * Until now an appraiser's identity was whatever the roster spreadsheet asserted: one name cell,
 * split on the last whitespace token, with a PAN and an Aadhaar number beside it that nobody had
 * ever checked against a card. There was no field anywhere for "the name as printed on the
 * Aadhaar", so the record's name could not be compared with the document's — because the
 * document's name was never written down.
 *
 * ## Why these columns live on the document and not on the person
 *
 * A person has both an Aadhaar row and a PAN row, and the entire point of recording the printed
 * details is that the two may disagree — with each other and with the roster. One set of columns
 * on `assayers` would have nowhere to put the second card's version, which is the comparison
 * itself. `document_number` already lives here for exactly this reason.
 *
 * ## Why they are not encrypted
 *
 * `assayers.display_name` and `assayers.address` are plaintext today, so encrypting the same facts
 * here would protect nothing while making them uncomparable — AES-GCM is non-deterministic, so an
 * encrypted column cannot be grouped or joined. They are still identity data, so they join
 * `IDENTITY_FIELDS` in `assayer-visibility.ts` and are stripped for roles that may not see the PAN.
 */
export class AssayerIdentityAsPrinted1795700000000 implements MigrationInterface {
  name = 'AssayerIdentityAsPrinted1795700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayer_documents"
        ADD COLUMN IF NOT EXISTS "holder_name"          varchar(200),
        ADD COLUMN IF NOT EXISTS "holder_date_of_birth" date,
        ADD COLUMN IF NOT EXISTS "holder_gender"        varchar(20),
        ADD COLUMN IF NOT EXISTS "holder_guardian_name" varchar(200),
        ADD COLUMN IF NOT EXISTS "holder_address"       text,
        ADD COLUMN IF NOT EXISTS "name_match_grade"     varchar(10),
        ADD COLUMN IF NOT EXISTS "name_match_note"      text,
        ADD COLUMN IF NOT EXISTS "rejection_reason"     varchar(40)
    `);

    /**
     * A rejection without a reason is a dead end for the person who has to act on it.
     *
     * Enforced in the database and not only in the service, because the service is not the only
     * writer this table will ever have — a fixture, a backfill or a future route would otherwise
     * be free to leave an appraiser looking at "sent back" with nothing telling them why.
     */
    await queryRunner.query(`
      ALTER TABLE "assayer_documents"
        ADD CONSTRAINT "CHK_assayer_documents_rejection_reason"
        CHECK ("verification_status" <> 'REJECTED' OR "rejection_reason" IS NOT NULL)
    `);

    /**
     * The name of record, derived from whichever identity document established it.
     *
     * Never typed. `RosterRecordsService.deriveLegalName` is the only writer, and it re-derives
     * from the documents whenever one is verified or a verification is undone, so the pair can
     * always be traced back to the card it came from.
     */
    await queryRunner.query(`
      ALTER TABLE "assayers"
        ADD COLUMN IF NOT EXISTS "legal_name"           varchar(200),
        ADD COLUMN IF NOT EXISTS "legal_name_source"    varchar(40),
        ADD COLUMN IF NOT EXISTS "identity_verified_at" timestamptz
    `);

    // The workforce queue asks "who has no verified identity" on every scan; without this it is a
    // sequential scan of the whole table each time.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayers_identity_verified"
        ON "assayers" ("identity_verified_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assayers_identity_verified"`);
    await queryRunner.query(`
      ALTER TABLE "assayers"
        DROP COLUMN IF EXISTS "legal_name",
        DROP COLUMN IF EXISTS "legal_name_source",
        DROP COLUMN IF EXISTS "identity_verified_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "assayer_documents"
        DROP CONSTRAINT IF EXISTS "CHK_assayer_documents_rejection_reason"
    `);
    await queryRunner.query(`
      ALTER TABLE "assayer_documents"
        DROP COLUMN IF EXISTS "holder_name",
        DROP COLUMN IF EXISTS "holder_date_of_birth",
        DROP COLUMN IF EXISTS "holder_gender",
        DROP COLUMN IF EXISTS "holder_guardian_name",
        DROP COLUMN IF EXISTS "holder_address",
        DROP COLUMN IF EXISTS "name_match_grade",
        DROP COLUMN IF EXISTS "name_match_note",
        DROP COLUMN IF EXISTS "rejection_reason"
    `);
  }
}

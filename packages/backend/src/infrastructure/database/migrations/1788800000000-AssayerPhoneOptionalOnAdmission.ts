import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A roster is not a contact list: admitting an assayer no longer requires a phone number.
 *
 * The client rosters this product is actually fed carry code, name, residence address, location,
 * district, state and zone — seven columns, no phone. With `phone` NOT NULL the roster importer
 * refused all 25 people in such a file, one "Phone is required" line each, and the only way past
 * it was for an operator to invent numbers into a payroll-adjacent record.
 *
 * The justification for the constraint did not hold either: phone was described as the assayer's
 * login identifier, but `AuthService` resolves a sign-in against assayer code, phone OR email, so
 * a phoneless assayer signs in with their code. What a missing phone actually costs is the
 * ability to *ring* them — Call & Assign and phone-channel dispatch — which is a capability gap
 * on the record, not a reason to refuse the record.
 *
 * So the gap moves to where gaps already live: `CRITICAL_FIELDS` on the HR record shows "Phone —
 * blocks calling and dispatch", and the assayer opens at INVITED, which the recommendation
 * engine's deployability filter already excludes from planning until they reach ACTIVE. Nothing
 * undeployable escapes; it is simply admitted first and completed after, which is the order the
 * paperwork actually arrives in.
 *
 * Reversible: `down` restores NOT NULL, and can only do so once every row has a phone, so it
 * fails loudly rather than inventing values.
 */
export class AssayerPhoneOptionalOnAdmission1788800000000 implements MigrationInterface {
  name = 'AssayerPhoneOptionalOnAdmission1788800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "phone" DROP NOT NULL`);

    // Rows imported before this change may carry a placeholder standing in for the number the
    // constraint demanded. An empty string is not a phone number, and leaving it as one means
    // "has a phone" queries count it — so it becomes NULL, which is what it always meant.
    await queryRunner.query(`UPDATE "assayers" SET "phone" = NULL WHERE trim("phone") = ''`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = await queryRunner.query(
      `SELECT count(*)::int AS count FROM "assayers" WHERE "phone" IS NULL`,
    );
    if (count > 0) {
      throw new Error(
        `Cannot restore NOT NULL on assayers.phone: ${count} assayer(s) have no phone number. ` +
          `Fill them in (HR → Roster shows them as incomplete) before reverting this migration.`,
      );
    }
    await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "phone" SET NOT NULL`);
  }
}

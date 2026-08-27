import { MigrationInterface, QueryRunner } from 'typeorm';
import { pincodeFromAddress } from '@fapoms/shared';

/**
 * Move the pincode out of the address line and into the pincode column.
 *
 * The appraiser roster was a spreadsheet with one free-text address field and no pincode column,
 * so the number was written at the end of the address: 1,111 of 1,163 records carry one there
 * and 8 have it in the column. Everything that wanted a pincode was reading the empty field —
 * the "Pincode — Not recorded" flag on every record, and the geocoder, for which a pincode is
 * the single strongest signal it has.
 *
 * Read through `pincodeFromAddress`, not a regex here, because the reading needs judgement the
 * SQL cannot express: the **last** six-digit run rather than the first (house numbers come
 * earlier — "Z603364, Sundar Nagri … Punjab-152116" has two), a leading digit of 1–8 for a
 * civilian pincode, and agreement with the state's postal circle. A wrong pincode is worse than
 * a blank one: it would put somebody's home in another state with more confidence than an empty
 * field ever could.
 *
 * Only fills what is empty. A pincode somebody typed is left exactly as it is.
 */
export class PincodeFromAddress1792700000000 implements MigrationInterface {
  name = 'PincodeFromAddress1792700000000';

  public async up(q: QueryRunner): Promise<void> {
    const rows: { id: string; address: string | null; state: string | null }[] = await q.query(`
      SELECT id, address, state FROM "assayers"
      WHERE (pincode IS NULL OR pincode = '') AND address ~ '[0-9]{6}'
    `);

    let filled = 0;
    const refused: string[] = [];
    for (const row of rows) {
      const { pincode, reason } = pincodeFromAddress(row.address, row.state);
      if (!pincode) {
        if (reason) refused.push(reason);
        continue;
      }
      await q.query(`UPDATE "assayers" SET pincode = $1 WHERE id = $2`, [pincode, row.id]);
      filled++;
    }

    // Logged rather than written to the import-issue queue: this runs once, against rows that
    // already exist, and a migration that quietly changed 1,111 records should say what it did.
    // eslint-disable-next-line no-console
    console.log(
      `[PincodeFromAddress] ${filled} of ${rows.length} addresses yielded a pincode. `
      + `${refused.length} refused${refused.length ? `: ${refused.slice(0, 3).join(' | ')}` : ''}`,
    );
  }

  /**
   * Not reversible. The column was empty for these rows and is now correct; putting it back
   * would delete a true fact to restore an absence, and the address it was read from is
   * untouched either way.
   */
  public async down(): Promise<void> {
    // Intentionally empty — see above.
  }
}

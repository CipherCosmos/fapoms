import { MigrationInterface, QueryRunner } from 'typeorm';
import { pincodeFromAddress, stateFromAddressAndPincode, resolveRegion } from '@fapoms/shared';

/**
 * Records whose state column contradicts their own pincode.
 *
 * Four of the 1,107 imported records claim a state their pincode does not belong to, and in
 * every one the state column is the wrong half — the district and the address text both name the
 * state the pincode agrees with. "Susta, Muzaffarpur, Bihar-847107" was filed under U.P;
 * "Paikapara, Murshidabad, West Bengal-742212" under U.P; one record's state column holds
 * "Jahangirpura", which is a locality in Surat.
 *
 * This is not tidiness. `region` is derived from the state, and two of those people were scoped
 * NORTH while living in the East — so the desk that covers them could not see them in a list,
 * and a desk that does not cover them could.
 *
 * Corrected only where the address names exactly one state from the pincode's own circle.
 * Anything ambiguous is logged and left alone: guessing which of two states somebody lives in is
 * how a record acquires a confident wrong answer, which is worse than the visible disagreement
 * it replaces.
 */
export class StateContradictsPincode1792800000000 implements MigrationInterface {
  name = 'StateContradictsPincode1792800000000';

  public async up(q: QueryRunner): Promise<void> {
    const rows: { id: string; assayer_code: string; address: string | null; state: string; pincode: string; region: string | null }[] =
      await q.query(`
        SELECT id, assayer_code, address, state, pincode, region FROM "assayers"
        WHERE pincode IS NOT NULL AND pincode <> ''
      `);

    const corrected: string[] = [];
    const leftAlone: string[] = [];

    for (const row of rows) {
      // Re-runs the circle check against the stored pincode by presenting it as the address.
      if (pincodeFromAddress(`addr ${row.pincode}`, row.state).pincode) continue;

      const state = stateFromAddressAndPincode(row.address, row.pincode);
      if (!state) {
        leftAlone.push(`${row.assayer_code} (state "${row.state}", pincode ${row.pincode})`);
        continue;
      }

      const region = resolveRegion(state) ?? null;
      await q.query(`UPDATE "assayers" SET state = $1, region = $2 WHERE id = $3`, [state, region, row.id]);
      corrected.push(`${row.assayer_code}: "${row.state}" → ${state}${row.region !== region ? ` (region ${row.region} → ${region})` : ''}`);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[StateContradictsPincode] corrected ${corrected.length}${corrected.length ? `: ${corrected.join('; ')}` : ''}. `
      + `${leftAlone.length} left for a person${leftAlone.length ? `: ${leftAlone.join('; ')}` : ''}.`,
    );
  }

  /**
   * Not reversible. The previous value was wrong — the address, the district and the pincode all
   * said so — and restoring it would put two people back in a region they do not live in.
   */
  public async down(): Promise<void> {
    // Intentionally empty — see above.
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CONSTRAIN CLIENT EMPANELMENT STANDING to the eight states the product actually defines.
 *
 * ## Why this exists
 *
 * `PUT /assayers/:assayerId/empanelment/:clientId` took `@Body() body: any`. The service it calls
 * declares `status: EmpanelmentStatus`, but nothing enforced that declaration, so whatever string
 * the request carried was written to a `varchar(30)` column verbatim. Confirmed live against a
 * running deployment: `BANANA`, `SUPER_ACTIVE`, a lower-case `active` and a string of SQL text all
 * returned 200 and all persisted.
 *
 * The lower-case case is the one that does real damage quietly. `standingAllowsPlanning()` matches
 * against the canonical upper-case set, so an assayer whose standing reads `active` is treated
 * everywhere as not empanelled: excluded from planning recommendations, refused by the assignment
 * eligibility policy, and invisible in every "who can take this client's work" answer. Nothing
 * reports an error. The person simply stops being offered work, and the standing on screen still
 * says they are active.
 *
 * The controller now validates with `@IsEnum(EmpanelmentStatus)` (`SetEmpanelmentDto`). This adds
 * the second half: a CHECK constraint, so a value that reaches the column by any other route —
 * a future endpoint, an import, a repair script, a hand-run UPDATE — is refused by the database
 * rather than accepted and left to poison eligibility silently.
 *
 * ## The repair, stated explicitly
 *
 * A CHECK constraint cannot be added over rows that violate it, so existing values were
 * inventoried first and each one classified by hand. Exactly one non-conforming value existed in
 * ordinary data:
 *
 *   EMPANELLED — 1 row, `is_active = false`.
 *
 * That is the legacy spelling of ACTIVE from before the vocabulary was named, and its meaning is
 * unambiguous: the person was empanelled with that client. It is mapped to ACTIVE, and the
 * original string is preserved in `status_reason` so the repair is legible in the row itself
 * rather than only in this file. The row is already withdrawn (`is_active = false`) and every
 * eligibility query filters on that column, so the mapping changes no operational outcome — it
 * makes an inert row conform without inventing a decision anybody has to trust.
 *
 * No other value is mapped. Anything else that turns up is left alone and the migration fails
 * loudly on the constraint, because guessing what an unrecognised standing meant is exactly the
 * silent behaviour this migration exists to end. If that happens, inventory the values, classify
 * them here, and re-run.
 *
 * ## On SUSPENDED and EXPIRED
 *
 * The assignment eligibility policy hard-blocks four standings: REJECTED, TERMINATED, EXPIRED and
 * SUSPENDED. Only the first two are in `EmpanelmentStatus`. The other two are defensive — nothing
 * in the product can set them — and this constraint makes them unreachable through the database
 * as well. They are deliberately NOT added to the enum: adding a state the product cannot produce
 * or resolve would be inventing workflow, and the policy losing nothing by naming a superset is
 * the safer side of that trade. The policy keeps them; the column refuses them.
 */
export class EmpanelmentStatusIntegrity1796700000000 implements MigrationInterface {
  name = 'EmpanelmentStatusIntegrity1796700000000';

  /** The eight states `EmpanelmentStatus` defines. Kept in one place, used by both directions. */
  private static readonly ALLOWED = [
    'RECOMMENDED',
    'NOT_RECOMMENDED',
    'ACTIVE',
    'REJECTED',
    'RESIGNED',
    'DOCUMENTS_PENDING',
    'INACTIVE',
    'TERMINATED',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const list = EmpanelmentStatusIntegrity1796700000000.ALLOWED.map((s) => `'${s}'`).join(', ');

    // The one classified repair. Narrow by value AND by the state that made the classification
    // safe, so it cannot quietly catch a future EMPANELLED row that is live.
    await queryRunner.query(`
      UPDATE assayer_client_empanelments
      SET status = 'ACTIVE',
          status_reason = COALESCE(status_reason || ' | ', '')
            || 'Repaired by migration 1796700000000: legacy standing "EMPANELLED" mapped to ACTIVE.'
      WHERE status = 'EMPANELLED' AND is_active = false
    `);

    // Report anything still non-conforming before the constraint refuses it, so the failure names
    // the values rather than only the constraint.
    const remaining: Array<{ status: string; n: string }> = await queryRunner.query(`
      SELECT status, count(*)::text AS n FROM assayer_client_empanelments
      WHERE status NOT IN (${list})
      GROUP BY status
    `);
    if (remaining.length > 0) {
      const detail = remaining.map((r) => `${r.status} (${r.n} rows)`).join(', ');
      throw new Error(
        `Cannot constrain assayer_client_empanelments.status: unclassified values present — ${detail}. `
        + 'Classify each one in migration 1796700000000 and re-run. Do not map them blindly.',
      );
    }

    await queryRunner.query(`
      ALTER TABLE assayer_client_empanelments
      ADD CONSTRAINT chk_empanelment_status CHECK (status IN (${list}))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only the constraint comes off. The EMPANELLED → ACTIVE repair is not reversed: restoring a
    // value the application cannot interpret would reintroduce the defect, and the original
    // string is recorded in `status_reason` for anyone who needs to see what it was.
    await queryRunner.query(`
      ALTER TABLE assayer_client_empanelments
      DROP CONSTRAINT IF EXISTS chk_empanelment_status
    `);
  }
}

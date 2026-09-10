import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * THE PAYOUT-EVIDENCE CHECK LET THE ONE ROW IT WAS WRITTEN TO REFUSE STRAIGHT THROUGH.
 *
 * Migration 1797300000000 added this constraint to `assayer_payables` and `billing_payments`:
 *
 *     CHECK (
 *       (destination_verified_at IS NULL AND destination_verified_source IS NULL
 *          AND payout_evidence_version_id IS NULL)
 *       OR
 *       (destination_verified_at IS NOT NULL
 *          AND destination_verified_source IN ('BANK_PASSBOOK', 'IDENTITY_DOCUMENT'))
 *     )
 *
 * and it accepts `destination_verified_at = now(), destination_verified_source = NULL` — which is
 * EXACTLY the row the `?? new Date()` fallback used to write, and the only row the constraint
 * existed to make unrepresentable.
 *
 * ## Why
 *
 * `IN` over a NULL left-hand side is NULL, not false. So for that row the second branch is
 * `TRUE AND NULL` = NULL, the first branch is FALSE, and the whole expression is
 * `FALSE OR NULL` = NULL. A CHECK constraint refuses a row only when its expression is FALSE;
 * NULL is treated as satisfied, by the SQL standard and by Postgres. Verified directly:
 *
 *     SELECT (NULL IN ('BANK_PASSBOOK','IDENTITY_DOCUMENT')) IS NULL;  -- t
 *     SELECT (false OR (true AND NULL)) IS NULL;                       -- t
 *
 * Nothing about the original reads wrong, which is the point: the other four shapes it was meant
 * to refuse — an unknown source, an empty source, a source with no timestamp, an evidence pointer
 * with no timestamp — are all genuinely refused, because each of those makes some comparison
 * FALSE rather than NULL. Only the NULL source slipped, and the NULL source is the defect.
 *
 * ## What this changes
 *
 * `destination_verified_source IS NOT NULL` is added to the second branch. It turns that branch
 * FALSE instead of NULL when no source is named, so the row is refused. The five shapes the
 * original did refuse are unaffected — this only narrows.
 *
 * It also normalises and then forbids one incoherent combination the original permitted:
 * `IDENTITY_DOCUMENT` alongside a `payout_evidence_version_id`. That pointer means "this claim
 * rests on that verified document version"; an identity-tier claim rests on
 * `assayers.identity_verified_at` and points at no document. `resolvePayoutDestination` has never
 * produced it and 1797300000000's repair could not create it (it classifies as
 * `IDENTITY_DOCUMENT` only `WHERE payout_evidence_version_id IS NULL`), so the UPDATE below is
 * expected to touch nothing — it is here so this migration cannot fail on a database that reached
 * that state some other way, which is the failure mode of adding a constraint to live data.
 *
 * `payout-destination-evidence.db.spec.ts` is the check on the check: it inserts each shape into
 * both real tables and asserts which ones come back refused.
 */
export class PayoutDestinationEvidenceNullFix1797600000000 implements MigrationInterface {
  name = 'PayoutDestinationEvidenceNullFix1797600000000';

  private static readonly TABLES = ['assayer_payables', 'billing_payments'] as const;

  private static constraintOf(table: string): string {
    return `chk_${table}_destination_evidence`;
  }

  public async up(q: QueryRunner): Promise<void> {
    for (const table of PayoutDestinationEvidenceNullFix1797600000000.TABLES) {
      // How many rows the broken constraint was letting through, before it is replaced. Zero on a
      // database where 1797300000000 did its repair and nothing has written since; not
      // necessarily zero on one that has been running with the hole open.
      const slipped = await q.query(`
        SELECT count(*)::text AS n FROM ${table}
         WHERE destination_verified_at IS NOT NULL AND destination_verified_source IS NULL
      `);
      const incoherent = await q.query(`
        SELECT count(*)::text AS n FROM ${table}
         WHERE destination_verified_source = 'IDENTITY_DOCUMENT' AND payout_evidence_version_id IS NOT NULL
      `);
      // eslint-disable-next-line no-console
      console.log(
        `[PayoutDestinationEvidenceNullFix] ${table}: ${slipped[0]?.n} row(s) claim verification with no source ` +
          `(the shape the old CHECK let through), ${incoherent[0]?.n} row(s) name identity evidence and a document pointer.`,
      );

      // The same repair 1797300000000 makes, applied to whatever slipped past it afterwards: an
      // identity-backed claim keeps the identity's own date, everything else stops claiming.
      await q.query(`
        INSERT INTO audit_events (category, event_type, entity_type, entity_id, user_id, outcome, remarks, metadata)
        SELECT 'SYSTEM', 'PAYOUT_DESTINATION_VERIFICATION_REPAIRED',
               '${table === 'assayer_payables' ? 'PAYABLE' : 'PAYMENT'}', t.id, NULL, 'SUCCESS',
               'Payout destination verification carried no source. The CHECK added by PayoutDestinationEvidence1797300000000 should have refused this row and did not: IN over a NULL source yields NULL, and a CHECK treats NULL as satisfied.',
               jsonb_build_object(
                 'previousDestinationVerifiedAt', t.destination_verified_at,
                 'newDestinationVerifiedAt', a.identity_verified_at,
                 'classification', CASE WHEN a.identity_verified_at IS NOT NULL THEN 'IDENTITY_DOCUMENT' ELSE 'NO_EVIDENCE' END,
                 'migration', 'PayoutDestinationEvidenceNullFix1797600000000'
               )
          FROM ${table} t
          LEFT JOIN assayers a ON a.id = t.assayer_id
         WHERE t.destination_verified_at IS NOT NULL AND t.destination_verified_source IS NULL
      `);
      await q.query(`
        UPDATE ${table} t
           SET destination_verified_at = a.identity_verified_at,
               destination_verified_source = CASE WHEN a.identity_verified_at IS NOT NULL THEN 'IDENTITY_DOCUMENT' ELSE NULL END,
               payout_evidence_version_id = NULL
          FROM assayers a
         WHERE a.id = t.assayer_id
           AND t.destination_verified_at IS NOT NULL
           AND t.destination_verified_source IS NULL
      `);
      await q.query(`
        UPDATE ${table} t
           SET destination_verified_at = NULL, payout_evidence_version_id = NULL
         WHERE t.destination_verified_at IS NOT NULL
           AND t.destination_verified_source IS NULL
      `);

      // An identity-tier claim points at no document. Clear the pointer, keep the claim.
      await q.query(`
        UPDATE ${table}
           SET payout_evidence_version_id = NULL
         WHERE destination_verified_source = 'IDENTITY_DOCUMENT'
           AND payout_evidence_version_id IS NOT NULL
      `);

      const constraint = PayoutDestinationEvidenceNullFix1797600000000.constraintOf(table);
      await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`);
      await q.query(`
        ALTER TABLE "${table}"
        ADD CONSTRAINT "${constraint}"
        CHECK (
          (destination_verified_at IS NULL
             AND destination_verified_source IS NULL
             AND payout_evidence_version_id IS NULL)
          OR
          (destination_verified_at IS NOT NULL
             AND destination_verified_source IS NOT NULL
             AND destination_verified_source IN ('BANK_PASSBOOK', 'IDENTITY_DOCUMENT')
             AND (destination_verified_source <> 'IDENTITY_DOCUMENT' OR payout_evidence_version_id IS NULL))
        )
      `);
    }
  }

  /**
   * Puts back the constraint 1797300000000 wrote, hole and all, because that is what `down` means
   * here. The repaired rows stay repaired — a fabricated timestamp is not something to restore,
   * and the audit rows above are the record of what each row used to hold.
   */
  public async down(q: QueryRunner): Promise<void> {
    for (const table of PayoutDestinationEvidenceNullFix1797600000000.TABLES) {
      const constraint = PayoutDestinationEvidenceNullFix1797600000000.constraintOf(table);
      await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`);
      await q.query(`
        ALTER TABLE "${table}"
        ADD CONSTRAINT "${constraint}"
        CHECK (
          (destination_verified_at IS NULL
             AND destination_verified_source IS NULL
             AND payout_evidence_version_id IS NULL)
          OR
          (destination_verified_at IS NOT NULL
             AND destination_verified_source IN ('BANK_PASSBOOK', 'IDENTITY_DOCUMENT'))
        )
      `);
    }
  }
}

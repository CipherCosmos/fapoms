import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A PAYOUT DESTINATION MAY NOT CLAIM A VERIFICATION THAT NEVER HAPPENED.
 *
 * `assayer_payables.destination_verified_at` and `billing_payments.destination_verified_at` say
 * "somebody verified the bank account this money went to, at this moment". Both writers —
 * `BillingEngineService.approvePayableInTx` and `.recordDisbursement` — ended the same expression
 * with `?? new Date()`:
 *
 *     destinationVerifiedAt = isVerifiedDoc ? (bankDoc.verifiedAt ?? new Date())
 *                                           : (assayer.identityVerifiedAt ?? new Date());
 *
 * so an assayer with no BANK_PASSBOOK document and `identity_verified_at` NULL — no evidence of
 * any kind — was stamped "verified, this second" at the instant of approval, and the payment row
 * copied the claim. Certification found five such payables covering money that had actually left
 * the business. Every one of them was indistinguishable, in the data, from a genuinely verified
 * payout.
 *
 * ## What this migration does
 *
 * 1. Adds `destination_verified_source` to both tables. The timestamp on its own cannot be
 *    checked; naming the evidence is what makes it checkable — and what tells a real
 *    identity-backed verification apart from a fabricated one after the fact, which is exactly
 *    the question nobody could answer about those five rows. See `payout-destination.ts` for the
 *    ladder (verified BANK_PASSBOOK → established identity → nothing).
 *
 * 2. Classifies and repairs every existing row that claims verification, explicitly:
 *      • `payout_evidence_version_id` present  → BANK_PASSBOOK. The evidence pointer was never
 *        fabricated (it is written only when the document reads VERIFIED), so these rows are
 *        sound and only need their source named.
 *      • otherwise, the assayer has `identity_verified_at` → IDENTITY_DOCUMENT, and the timestamp
 *        is corrected to the evidence's own moment rather than the approval instant that was
 *        stamped over it. The old value is kept in the audit trail below.
 *      • otherwise → no evidence exists. `destination_verified_at` becomes NULL. Nothing is
 *        guessed: NULL is the honest description of a verification nobody can point to.
 *    A row with an evidence pointer but no timestamp is contradictory and has its pointer
 *    cleared, for the same reason.
 *
 * 3. Writes one `audit_events` row per repaired payable and payment, carrying the value that was
 *    removed, so the repair is not a silent rewrite of a money record. `audit_events` is
 *    append-only by trigger, which is the point.
 *
 * 4. Adds the CHECK constraints. They refuse the SILENT case permanently: a timestamp with
 *    nothing said about where it came from, and an evidence pointer with no timestamp. A CHECK
 *    cannot reach across to `assayers` to confirm the identity tier — that is what
 *    `resolvePayoutDestination` and its tests are for — but it does make "verified out of thin
 *    air" unrepresentable, which is the shape the defect actually took.
 *
 * Deliberately NOT enforced: `BANK_PASSBOOK` does not require `payout_evidence_version_id`.
 * `assayer_documents.current_version_id` is nullable and legacy documents verified before
 * document versioning have none — the document is the evidence, the version id is a finer
 * pointer at it. Requiring it would refuse approvals for people whose paperwork is genuinely in
 * order.
 */
export class PayoutDestinationEvidence1797300000000 implements MigrationInterface {
  name = 'PayoutDestinationEvidence1797300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "assayer_payables"
      ADD COLUMN IF NOT EXISTS "destination_verified_source" varchar(30) NULL
    `);
    await q.query(`
      ALTER TABLE "billing_payments"
      ADD COLUMN IF NOT EXISTS "destination_verified_source" varchar(30) NULL
    `);

    // ── Inventory, before anything is touched ──────────────────────────────────────────────
    const before = await q.query(`
      SELECT
        (SELECT count(*) FROM assayer_payables WHERE destination_verified_at IS NOT NULL)::text AS payables_claiming,
        (SELECT count(*) FROM assayer_payables WHERE destination_verified_at IS NOT NULL
           AND payout_evidence_version_id IS NULL)::text AS payables_no_passbook,
        (SELECT count(*) FROM billing_payments WHERE destination_verified_at IS NOT NULL)::text AS payments_claiming,
        (SELECT count(*) FROM billing_payments WHERE destination_verified_at IS NOT NULL
           AND payout_evidence_version_id IS NULL)::text AS payments_no_passbook
    `);
    // eslint-disable-next-line no-console
    console.log(
      `[PayoutDestinationEvidence] before: payables claiming verification=${before[0]?.payables_claiming} ` +
        `(without passbook evidence=${before[0]?.payables_no_passbook}), ` +
        `payments claiming=${before[0]?.payments_claiming} (without passbook evidence=${before[0]?.payments_no_passbook}).`,
    );

    // ── 1. Sound rows: the evidence pointer was never fabricated, so name its source ────────
    await q.query(`
      UPDATE assayer_payables SET destination_verified_source = 'BANK_PASSBOOK'
       WHERE destination_verified_at IS NOT NULL
         AND payout_evidence_version_id IS NOT NULL
         AND destination_verified_source IS NULL
    `);
    await q.query(`
      UPDATE billing_payments SET destination_verified_source = 'BANK_PASSBOOK'
       WHERE destination_verified_at IS NOT NULL
         AND payout_evidence_version_id IS NOT NULL
         AND destination_verified_source IS NULL
    `);

    // ── 2. Audit BEFORE repairing, so the removed value is on the record ───────────────────
    // `NOT_A_RECORD_ENTITY_ID` is not used here: these events are about specific rows, and
    // entity_id is the row. Written on this migration's transaction so the trail and the repair
    // land together.
    await q.query(`
      INSERT INTO audit_events (category, event_type, entity_type, entity_id, user_id, outcome, remarks, metadata)
      SELECT 'SYSTEM', 'PAYOUT_DESTINATION_VERIFICATION_REPAIRED', 'PAYABLE', p.id, NULL, 'SUCCESS',
             CASE WHEN a.identity_verified_at IS NOT NULL
                  THEN 'Payout destination verification re-dated to the identity evidence that backs it; the stored value was the approval instant, stamped by the ?? new Date() fallback.'
                  ELSE 'Payout destination verification cleared: no verified bank passbook and no established identity existed for this assayer, so the stored timestamp asserted a verification that never happened.'
             END,
             jsonb_build_object(
               'payableNumber', p.payable_number,
               'status', p.status,
               'assayerId', p.assayer_id,
               'previousDestinationVerifiedAt', p.destination_verified_at,
               'newDestinationVerifiedAt', a.identity_verified_at,
               'classification', CASE WHEN a.identity_verified_at IS NOT NULL THEN 'IDENTITY_DOCUMENT' ELSE 'NO_EVIDENCE' END,
               'migration', 'PayoutDestinationEvidence1797300000000'
             )
        FROM assayer_payables p
        LEFT JOIN assayers a ON a.id = p.assayer_id
       WHERE p.destination_verified_at IS NOT NULL
         AND p.payout_evidence_version_id IS NULL
    `);
    await q.query(`
      INSERT INTO audit_events (category, event_type, entity_type, entity_id, user_id, outcome, remarks, metadata)
      SELECT 'SYSTEM', 'PAYOUT_DESTINATION_VERIFICATION_REPAIRED', 'PAYMENT', bp.id, NULL, 'SUCCESS',
             CASE WHEN a.identity_verified_at IS NOT NULL
                  THEN 'Disbursement destination verification re-dated to the identity evidence that backs it.'
                  ELSE 'Disbursement destination verification cleared: no verified bank passbook and no established identity existed for this assayer.'
             END,
             jsonb_build_object(
               'paymentReference', bp.payment_reference,
               'payableId', bp.payable_id,
               'assayerId', bp.assayer_id,
               'amount', bp.amount,
               'previousDestinationVerifiedAt', bp.destination_verified_at,
               'newDestinationVerifiedAt', a.identity_verified_at,
               'classification', CASE WHEN a.identity_verified_at IS NOT NULL THEN 'IDENTITY_DOCUMENT' ELSE 'NO_EVIDENCE' END,
               'migration', 'PayoutDestinationEvidence1797300000000'
             )
        FROM billing_payments bp
        LEFT JOIN assayers a ON a.id = bp.assayer_id
       WHERE bp.destination_verified_at IS NOT NULL
         AND bp.payout_evidence_version_id IS NULL
    `);

    // ── 3. The repair itself ───────────────────────────────────────────────────────────────
    const repairedPayables = await q.query(`
      UPDATE assayer_payables p
         SET destination_verified_at = a.identity_verified_at,
             destination_verified_source = CASE WHEN a.identity_verified_at IS NOT NULL THEN 'IDENTITY_DOCUMENT' ELSE NULL END
        FROM assayers a
       WHERE a.id = p.assayer_id
         AND p.destination_verified_at IS NOT NULL
         AND p.payout_evidence_version_id IS NULL
      RETURNING p.id
    `);
    // An orphaned payable (no assayer row at all) cannot be classified from evidence either.
    const orphanPayables = await q.query(`
      UPDATE assayer_payables p
         SET destination_verified_at = NULL, destination_verified_source = NULL
       WHERE p.destination_verified_at IS NOT NULL
         AND p.payout_evidence_version_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM assayers a WHERE a.id = p.assayer_id)
      RETURNING p.id
    `);
    const repairedPayments = await q.query(`
      UPDATE billing_payments bp
         SET destination_verified_at = a.identity_verified_at,
             destination_verified_source = CASE WHEN a.identity_verified_at IS NOT NULL THEN 'IDENTITY_DOCUMENT' ELSE NULL END
        FROM assayers a
       WHERE a.id = bp.assayer_id
         AND bp.destination_verified_at IS NOT NULL
         AND bp.payout_evidence_version_id IS NULL
      RETURNING bp.id
    `);
    const orphanPayments = await q.query(`
      UPDATE billing_payments bp
         SET destination_verified_at = NULL, destination_verified_source = NULL
       WHERE bp.destination_verified_at IS NOT NULL
         AND bp.payout_evidence_version_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM assayers a WHERE a.id = bp.assayer_id)
      RETURNING bp.id
    `);

    // An evidence pointer with no timestamp behind it says nothing and would fail the constraint.
    await q.query(`
      UPDATE assayer_payables SET payout_evidence_version_id = NULL
       WHERE destination_verified_at IS NULL AND payout_evidence_version_id IS NOT NULL
    `);
    await q.query(`
      UPDATE billing_payments SET payout_evidence_version_id = NULL
       WHERE destination_verified_at IS NULL AND payout_evidence_version_id IS NOT NULL
    `);

    const after = await q.query(`
      SELECT
        (SELECT count(*) FROM assayer_payables WHERE destination_verified_at IS NOT NULL)::text AS payables_claiming,
        (SELECT count(*) FROM assayer_payables WHERE destination_verified_source = 'BANK_PASSBOOK')::text AS payables_passbook,
        (SELECT count(*) FROM assayer_payables WHERE destination_verified_source = 'IDENTITY_DOCUMENT')::text AS payables_identity,
        (SELECT count(*) FROM billing_payments WHERE destination_verified_at IS NOT NULL)::text AS payments_claiming
    `);
    // eslint-disable-next-line no-console
    console.log(
      `[PayoutDestinationEvidence] repaired ${repairedPayables.length + orphanPayables.length} payable(s) and ` +
        `${repairedPayments.length + orphanPayments.length} payment(s). After: payables claiming verification=` +
        `${after[0]?.payables_claiming} (passbook=${after[0]?.payables_passbook}, identity=${after[0]?.payables_identity}), ` +
        `payments claiming=${after[0]?.payments_claiming}. Every remaining claim now names its evidence.`,
    );

    // ── 4. Make the impossible combination unrepresentable ─────────────────────────────────
    await q.query(`ALTER TABLE "assayer_payables" DROP CONSTRAINT IF EXISTS "chk_assayer_payables_destination_evidence"`);
    await q.query(`
      ALTER TABLE "assayer_payables"
      ADD CONSTRAINT "chk_assayer_payables_destination_evidence"
      CHECK (
        (destination_verified_at IS NULL
           AND destination_verified_source IS NULL
           AND payout_evidence_version_id IS NULL)
        OR
        (destination_verified_at IS NOT NULL
           AND destination_verified_source IN ('BANK_PASSBOOK', 'IDENTITY_DOCUMENT'))
      )
    `);
    await q.query(`ALTER TABLE "billing_payments" DROP CONSTRAINT IF EXISTS "chk_billing_payments_destination_evidence"`);
    await q.query(`
      ALTER TABLE "billing_payments"
      ADD CONSTRAINT "chk_billing_payments_destination_evidence"
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

  /**
   * The constraints and the column go; the repaired data stays. `down` cannot restore a
   * fabricated timestamp, and would not want to — the audit rows written above are the record of
   * what each row used to hold.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "billing_payments" DROP CONSTRAINT IF EXISTS "chk_billing_payments_destination_evidence"`);
    await q.query(`ALTER TABLE "assayer_payables" DROP CONSTRAINT IF EXISTS "chk_assayer_payables_destination_evidence"`);
    await q.query(`ALTER TABLE "billing_payments" DROP COLUMN IF EXISTS "destination_verified_source"`);
    await q.query(`ALTER TABLE "assayer_payables" DROP COLUMN IF EXISTS "destination_verified_source"`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes a payment reference unique per target, so a retried POST cannot pay twice.
 *
 * `recordPayment` and `recordDisbursement` had no idempotency key: a mobile or flaky-network
 * client that retried the same request recorded the payment a second time, and every guard
 * accepted it because a second legitimate-looking payment is indistinguishable from a first.
 * `paymentReference` (a UTR, cheque number or disbursement reference) is the natural key — a
 * retry carries the same one — so making it unique per invoice / per payable turns a duplicate
 * into a database-level impossibility rather than a matter of the application remembering to
 * check.
 *
 * Two partial indexes rather than one because a payment is attached to exactly one of the two:
 * INBOUND rows carry `invoice_id`, OUTBOUND rows carry `payable_id`. A reference is free to
 * repeat across different invoices or a different direction — only "the same reference against
 * the same target" is a duplicate.
 *
 * Additive and non-destructive: no column changes, no data rewrite. It can fail only if the
 * table already contains a genuine duplicate, which is exactly the state this is meant to
 * forbid — see the pre-check query in `down`'s sibling note. Expressed as raw SQL because a
 * partial unique index (the `WHERE`) has no decorator form; it is created `CONCURRENTLY`-free
 * because a migration runs while the app is not yet serving, and CONCURRENTLY cannot run
 * inside the migration's transaction.
 */
export class AddPaymentIdempotency1787700000000 implements MigrationInterface {
  name = 'AddPaymentIdempotency1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_payments_inbound_ref"
        ON "billing_payments" ("invoice_id", "payment_reference")
        WHERE "invoice_id" IS NOT NULL AND "direction" = 'INBOUND'
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_payments_outbound_ref"
        ON "billing_payments" ("payable_id", "payment_reference")
        WHERE "payable_id" IS NOT NULL AND "direction" = 'OUTBOUND'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_billing_payments_inbound_ref"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_billing_payments_outbound_ref"`);
  }
}

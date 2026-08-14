import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes billing tax-correct and gives it the client terms it needs.
 *
 * Three problems this fixes at the schema level:
 *
 *  1. `billing_entries` had no TDS *rate*, only an amount. The service tried to
 *     derive the rate by dividing the amount by 100, so TDS always evaluated to
 *     zero and every client line was over-billed by the amount that should have
 *     been withheld.
 *  2. `billing_entries` had nowhere to record the taxable value, so the code wrote
 *     base+travel+adjustment back over `base_amount`; a second recompute (any
 *     adjustment) folded travel in again and inflated the line.
 *  3. `client_billing` held payment terms and GSTIN but no rates, so there was
 *     nothing for billing to read and every entry defaulted to 0% tax.
 *
 * Existing rows are backfilled from the client's contracted rates and their
 * money is recomputed, so historical entries stop under-stating tax and TDS.
 */
export class AddBillingTaxAndTerms1786200000000 implements MigrationInterface {
  name = 'AddBillingTaxAndTerms1786200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE billing_entries
        ADD COLUMN IF NOT EXISTS tds_rate numeric(6,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS taxable_amount numeric(14,2) NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      ALTER TABLE billing_invoices
        ADD COLUMN IF NOT EXISTS tds_amount numeric(14,2) NOT NULL DEFAULT 0
    `);

    // Indian audit-services defaults; per-client because SEZ/exempt clients and
    // lower-deduction certificates are routine.
    await queryRunner.query(`
      ALTER TABLE client_billing
        ADD COLUMN IF NOT EXISTS gst_rate numeric(6,2) NOT NULL DEFAULT 18,
        ADD COLUMN IF NOT EXISTS tds_rate numeric(6,2) NOT NULL DEFAULT 10
    `);

    // Backfill the taxable value for rows written before the column existed. For
    // those rows base_amount already had travel/adjustment folded into it, so it
    // is the taxable figure minus discount.
    await queryRunner.query(`
      UPDATE billing_entries
         SET taxable_amount = GREATEST(base_amount - discount_amount, 0)
       WHERE taxable_amount = 0
    `);

    // Adopt each client's contracted rates on lines that were created untaxed and
    // have not yet been invoiced or paid — re-pricing an issued invoice would
    // change a document already sent to the client.
    await queryRunner.query(`
      UPDATE billing_entries e
         SET tax_rate = cb.gst_rate,
             tds_rate = cb.tds_rate
        FROM client_billing cb
       WHERE cb.client_id = e.client_id
         AND cb.is_active = true
         AND e.tax_rate = 0
         AND e.tds_rate = 0
         AND e.invoice_id IS NULL
         AND e.paid_amount = 0
    `);

    // Recompute money for exactly those rows, keeping the identity
    // total = taxable + GST - TDS.
    await queryRunner.query(`
      UPDATE billing_entries
         SET tax_amount = ROUND(taxable_amount * tax_rate / 100, 2),
             tds_amount = ROUND(taxable_amount * tds_rate / 100, 2),
             total_amount = ROUND(taxable_amount
                                  + (taxable_amount * tax_rate / 100)
                                  - (taxable_amount * tds_rate / 100), 2)
       WHERE invoice_id IS NULL
         AND paid_amount = 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE client_billing DROP COLUMN IF EXISTS tds_rate, DROP COLUMN IF EXISTS gst_rate`);
    await queryRunner.query(`ALTER TABLE billing_invoices DROP COLUMN IF EXISTS tds_amount`);
    await queryRunner.query(`ALTER TABLE billing_entries DROP COLUMN IF EXISTS taxable_amount, DROP COLUMN IF EXISTS tds_rate`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Client invoice numbers `INV/25-26/000123` (owner's decision, 2026-09-24 audit F7).
 *
 * Until now a client invoice was numbered `INV-<base36 clock>-<random six digits>`: unique, but not
 * consecutive, and with no financial year in it — GST Rule 46 asks for a consecutive serial of at
 * most 16 characters, unique within the financial year. The new number is exactly that: the
 * financial year (April–March, Indian dates) and a six-digit serial that starts at 000001 each year.
 *
 * One counter row per financial year. `createInvoice` takes the next serial with a single
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` INSIDE the invoice's own transaction, so:
 *  - two invoices created at once cannot get the same serial (the row lock serialises them), and
 *  - an invoice whose creation rolls back hands its serial back with it — no gaps from failures.
 * A Postgres SEQUENCE would have been simpler and would leave a gap on every rollback, because
 * `nextval` is never undone.
 *
 * Existing invoices keep the numbers they were issued under; `invoice_number` stays unique across
 * both forms (the old ones contain no "/", so they can never collide with a new one).
 *
 * No entity: nothing reads this table except the one statement that advances it. Not wiped by the
 * data reset on purpose — continuing a series after a wipe can never collide, restarting one can.
 */
export class ClientInvoiceNumberSeries1801300000100 implements MigrationInterface {
  name = 'ClientInvoiceNumberSeries1801300000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing_invoice_number_series" (
        "financial_year" character varying(5) NOT NULL,
        "last_serial" integer NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_billing_invoice_number_series" PRIMARY KEY ("financial_year"),
        CONSTRAINT "chk_billing_invoice_number_series_label" CHECK ("financial_year" ~ '^[0-9]{2}-[0-9]{2}$'),
        CONSTRAINT "chk_billing_invoice_number_series_serial" CHECK ("last_serial" BETWEEN 1 AND 999999)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "billing_invoice_number_series"`);
  }
}

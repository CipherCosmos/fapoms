import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Assayer invoicing: the consent-and-visibility wrapper over payables.
 *
 * Part of the negotiation-removal / money-blinding programme: the assayer sees no money anywhere
 * until ops invites them to invoice their unbilled work. The invoice holds NO money of its own —
 * its totals are SUMs of the stored `assayer_payables` amounts — so this migration creates the
 * wrapper table and teaches the payable two things:
 *
 *  - `assayer_invoice_id`: which invoice (if any) the payable currently rides. Nullable; nulled
 *    again on cancel/detach. Indexed because the invoice's lines are always read as a set.
 *  - `pre_invoicing_era`: grandfathering. Payables whose money already moved under the old rules
 *    (APPROVED/PAID, or partly paid) stay visible on the assayer's gated statement WITHOUT an
 *    invoice and are permanently excluded from invoice eligibility — deploying this feature must
 *    not make an assayer's already-revealed earnings vanish, and must never re-bill history.
 *
 * The partial unique index is the real one-active-invoice-per-assayer guard: two concurrent
 * invites race past any service-level check, and the loser catches this constraint by name
 * (`isUniqueViolation('UQ_assayer_invoices_one_active_per_assayer')`), exactly like the
 * fee-payable and reimbursement uniqueness backstops beside it.
 */
export class AssayerInvoicing1795800000000 implements MigrationInterface {
  name = 'AssayerInvoicing1795800000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── The wrapper table ──────────────────────────────────────────────────
    // Base-entity columns match the BaselineSchema convention for billing tables
    // (created_by/updated_by are varchar there, not uuid — kept consistent).
    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_invoices" (
        "id"                   uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by"           character varying,
        "created_at"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by"           character varying,
        "updated_at"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version"              integer NOT NULL DEFAULT 1,
        "is_active"            boolean NOT NULL DEFAULT true,
        "invoice_number"       character varying(50) NOT NULL,
        "assayer_id"           uuid NOT NULL,
        "status"               character varying(20) NOT NULL DEFAULT 'INVITED',
        "invited_at"           TIMESTAMP WITH TIME ZONE,
        "invited_by"           uuid,
        "submitted_at"         TIMESTAMP WITH TIME ZONE,
        "submitted_request_id" uuid,
        "approved_at"          TIMESTAMP WITH TIME ZONE,
        "approved_by"          uuid,
        "cancelled_at"         TIMESTAMP WITH TIME ZONE,
        "cancelled_by"         uuid,
        "cancel_reason"        text,
        "line_count"           integer NOT NULL DEFAULT 0,
        "subtotal_base"        numeric(14,2) NOT NULL DEFAULT '0',
        "subtotal_travel"      numeric(14,2) NOT NULL DEFAULT '0',
        "tds_amount"           numeric(14,2) NOT NULL DEFAULT '0',
        "total_amount"         numeric(14,2) NOT NULL DEFAULT '0',
        "currency"             character varying(3) NOT NULL DEFAULT 'INR',
        "notes"                text,
        CONSTRAINT "UQ_assayer_invoices_number" UNIQUE ("invoice_number"),
        CONSTRAINT "PK_assayer_invoices" PRIMARY KEY ("id")
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_assayer_invoices_assayer" ON "assayer_invoices" ("assayer_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_assayer_invoices_status" ON "assayer_invoices" ("status")`);
    // ONE active invoice per assayer — the name is load-bearing (isUniqueViolation matches on it).
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_assayer_invoices_one_active_per_assayer"
        ON "assayer_invoices" ("assayer_id")
        WHERE "status" IN ('INVITED','SUBMITTED')
    `);

    // ── The payable learns which invoice it rides ─────────────────────────
    await q.query(`
      ALTER TABLE "assayer_payables"
        ADD COLUMN IF NOT EXISTS "assayer_invoice_id" uuid NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayer_payables_assayer_invoice"
        ON "assayer_payables" ("assayer_invoice_id")
    `);
    await q.query(`
      ALTER TABLE "assayer_payables"
        ADD COLUMN IF NOT EXISTS "pre_invoicing_era" boolean NOT NULL DEFAULT false
    `);

    /**
     * Grandfather everything whose money already moved under the pre-invoicing rules. The
     * `paid_amount > 0` arm catches a partially-paid row whose status was later rewound (a
     * reversal dropped it back to APPROVED, or an old import left it PENDING) — money that left
     * the building was revealed, whatever the status column now says.
     */
    await q.query(`
      UPDATE "assayer_payables"
         SET "pre_invoicing_era" = true
       WHERE "status" IN ('APPROVED','PAID') OR "paid_amount" > 0
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "assayer_payables" DROP COLUMN IF EXISTS "pre_invoicing_era"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_assayer_payables_assayer_invoice"`);
    await q.query(`ALTER TABLE "assayer_payables" DROP COLUMN IF EXISTS "assayer_invoice_id"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_assayer_invoices_one_active_per_assayer"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_assayer_invoices_status"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_assayer_invoices_assayer"`);
    await q.query(`DROP TABLE IF EXISTS "assayer_invoices"`);
  }
}

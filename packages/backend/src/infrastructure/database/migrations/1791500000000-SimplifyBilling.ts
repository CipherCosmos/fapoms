import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Billing, made simple: the assignment is the ledger line.
 *
 * ## Why
 *
 * The billing schema was an enterprise AR/AP design — a fifteen-state approval pipeline stacked
 * on a four-state payment machine on the same row, client/project-level lines with pricing
 * models, split/merge lineage, a conflicts table with its own lifecycle, a client billing status
 * with its own history table, and a denormalised earnings counter on the assayer. The business
 * is: an assignment completes → we owe the assayer its fee, and we bill the client for it. Two
 * ledgers, one source. Everything here that a human never needed to type is removed; everything
 * that was derivable becomes derived.
 *
 * ## What changes
 *
 *   billing_entries   one per assignment (NOT NULL, unique); state ∈ UNBILLED/INVOICED/PAID/
 *                     CANCELLED; + on_hold/hold_reason, adjustment_reason, service_date;
 *                     − level, payment_state, pricing_model, rate, quantity, period start,
 *                       discount/billed/disputed/cancelled/adjusted amounts, parent/source ids.
 *   assayer_payables  + on_hold/hold_reason, expense_id (real column; the jsonb marker goes);
 *                     status ∈ PENDING/APPROVED/PAID; assignment_id NOT NULL; the fee-payable
 *                     unique index is now keyed on `expense_id IS NULL`; one payable per expense.
 *   billing_invoices  status ∈ DRAFT/ISSUED/PAID/CANCELLED; − type, discount_amount.
 *   billing_payments  − status, allocated_to_entry_ids; + CHECK amount > 0; the per-reference
 *                     idempotency indexes the service has relied on since 1787700000000 — which
 *                     only ever existed in `_historical/` and so never on a fresh database —
 *                     are created here for real.
 *   dropped           billing_conflicts, client_billing_history, client_billing.status,
 *                     assayers.total_earnings.
 *
 * ## Data
 *
 * Production holds zero money rows (the book was reset the day this shipped), so the
 * normalisation steps below are no-ops there. They exist for development databases and the
 * 85k-row scale book, and they are conservative: old pipeline states collapse to UNBILLED,
 * part-paid to INVOICED, holds/disputes to a flag, and rows that cannot exist in the new model
 * (split children, non-assignment lines) are deleted with a NOTICE of how many.
 *
 * Every statement is idempotent (`IF EXISTS` / `IF NOT EXISTS`), because a development database
 * running with `DB_SYNCHRONIZE=true` may already have been shaped by the entities.
 */
export class SimplifyBilling1791500000000 implements MigrationInterface {
  name = 'SimplifyBilling1791500000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── billing_entries: normalise data before touching the shape ─────────────────────────
    await q.query(`
      DO $$
      DECLARE n_children integer; n_orphans integer;
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'billing_entries' AND column_name = 'parent_entry_id') THEN
          DELETE FROM billing_entries WHERE parent_entry_id IS NOT NULL;
          GET DIAGNOSTICS n_children = ROW_COUNT;
          IF n_children > 0 THEN RAISE NOTICE 'SimplifyBilling: removed % split-child billing line(s)', n_children; END IF;
        END IF;
        DELETE FROM billing_entries WHERE assignment_id IS NULL;
        GET DIAGNOSTICS n_orphans = ROW_COUNT;
        IF n_orphans > 0 THEN RAISE NOTICE 'SimplifyBilling: removed % client/project-level billing line(s) (no assignment)', n_orphans; END IF;
      END $$;
    `);

    await q.query(`ALTER TABLE "billing_entries" ADD COLUMN IF NOT EXISTS "on_hold" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "billing_entries" ADD COLUMN IF NOT EXISTS "hold_reason" text`);
    await q.query(`ALTER TABLE "billing_entries" ADD COLUMN IF NOT EXISTS "adjustment_reason" text`);

    await q.query(`
      UPDATE billing_entries SET on_hold = true
       WHERE state IN ('ON_HOLD', 'DISPUTED') AND on_hold = false
    `);
    await q.query(`
      UPDATE billing_entries SET state = CASE
        WHEN state IN ('NOT_BILLABLE','PENDING_BILLING','READY_FOR_BILLING','DRAFT','SUBMITTED',
                       'UNDER_REVIEW','REJECTED','APPROVED','ADJUSTED','ON_HOLD','DISPUTED') THEN 'UNBILLED'
        WHEN state = 'PARTIALLY_PAID' THEN 'INVOICED'
        ELSE state END
       WHERE state NOT IN ('UNBILLED','INVOICED','PAID','CANCELLED')
    `);

    // The old partial unique index references parent_entry_id; it must go before that column does.
    await q.query(`DROP INDEX IF EXISTS "UQ_billing_entries_root_per_assignment"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_2e1b11d26d549df02511f8fd30"`); // (level)
    await q.query(`DROP INDEX IF EXISTS "IDX_6944cc76f6c31fbb6c9c321178"`); // (payment_state)

    await q.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'billing_entries' AND column_name = 'billing_period_end')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'billing_entries' AND column_name = 'service_date') THEN
          ALTER TABLE "billing_entries" RENAME COLUMN "billing_period_end" TO "service_date";
        END IF;
      END $$;
    `);
    await q.query(`ALTER TABLE "billing_entries" ADD COLUMN IF NOT EXISTS "service_date" date`);

    for (const col of [
      'level', 'payment_state', 'pricing_model', 'rate', 'quantity', 'billing_period_start',
      'billing_period_end', 'discount_amount', 'billed_amount', 'disputed_amount', 'cancelled_amount',
      'adjusted_amount', 'parent_entry_id', 'source_entry_id',
    ]) {
      await q.query(`ALTER TABLE "billing_entries" DROP COLUMN IF EXISTS "${col}"`);
    }

    await q.query(`ALTER TABLE "billing_entries" ALTER COLUMN "assignment_id" SET NOT NULL`);
    await q.query(`ALTER TABLE "billing_entries" ALTER COLUMN "state" SET DEFAULT 'UNBILLED'`);
    await q.query(`ALTER TABLE "billing_entries" DROP CONSTRAINT IF EXISTS "CK_billing_entries_state"`);
    await q.query(`
      ALTER TABLE "billing_entries"
        ADD CONSTRAINT "CK_billing_entries_state"
        CHECK (state IN ('UNBILLED','INVOICED','PAID','CANCELLED'))
    `);
    // A billed assignment cannot quietly disappear from under its money. Was SET NULL, which is
    // impossible now that the column is NOT NULL and was wrong before: it left orphan lines.
    await q.query(`ALTER TABLE "billing_entries" DROP CONSTRAINT IF EXISTS "FK_fbfd558dd94f3f65e86803e7fe9"`);
    await q.query(`
      ALTER TABLE "billing_entries"
        ADD CONSTRAINT "FK_fbfd558dd94f3f65e86803e7fe9"
        FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_entries_root_per_assignment"
        ON "billing_entries" ("assignment_id")
    `);

    // ── assayer_payables ─────────────────────────────────────────────────────────────────
    await q.query(`ALTER TABLE "assayer_payables" ADD COLUMN IF NOT EXISTS "on_hold" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "assayer_payables" ADD COLUMN IF NOT EXISTS "hold_reason" text`);
    await q.query(`ALTER TABLE "assayer_payables" ADD COLUMN IF NOT EXISTS "expense_id" uuid`);

    // The jsonb marker becomes a real column. Must precede the index swap below, or two
    // reimbursements on one assignment would collide on the new fee-payable predicate.
    await q.query(`
      UPDATE assayer_payables
         SET expense_id = (rate_snapshot->>'expenseId')::uuid
       WHERE expense_id IS NULL
         AND rate_snapshot->>'source' = 'EXPENSE_CLAIM'
         AND (rate_snapshot->>'expenseId') ~ '^[0-9a-fA-F-]{36}$'
    `);
    await q.query(`
      UPDATE assayer_payables SET on_hold = true
       WHERE status IN ('ON_HOLD', 'DISPUTED') AND on_hold = false
    `);
    await q.query(`
      UPDATE assayer_payables SET status = 'PENDING'
       WHERE status NOT IN ('PENDING','APPROVED','PAID')
    `);
    await q.query(`
      DO $$ DECLARE n integer; BEGIN
        DELETE FROM assayer_payables WHERE assignment_id IS NULL;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN RAISE NOTICE 'SimplifyBilling: removed % payable(s) with no assignment', n; END IF;
      END $$;
    `);
    await q.query(`ALTER TABLE "assayer_payables" ALTER COLUMN "assignment_id" SET NOT NULL`);

    await q.query(`DROP INDEX IF EXISTS "UQ_assayer_payables_fee_per_assignment"`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_assayer_payables_fee_per_assignment"
        ON "assayer_payables" ("assignment_id") WHERE "expense_id" IS NULL
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_assayer_payables_expense"
        ON "assayer_payables" ("expense_id") WHERE "expense_id" IS NOT NULL
    `);
    await q.query(`ALTER TABLE "assayer_payables" DROP CONSTRAINT IF EXISTS "FK_assayer_payables_expense"`);
    await q.query(`
      ALTER TABLE "assayer_payables"
        ADD CONSTRAINT "FK_assayer_payables_expense"
        FOREIGN KEY ("expense_id") REFERENCES "assignment_expenses"("id") ON DELETE SET NULL
    `);
    await q.query(`ALTER TABLE "assayer_payables" DROP CONSTRAINT IF EXISTS "CK_assayer_payables_status"`);
    await q.query(`
      ALTER TABLE "assayer_payables"
        ADD CONSTRAINT "CK_assayer_payables_status"
        CHECK (status IN ('PENDING','APPROVED','PAID'))
    `);

    // ── billing_invoices ─────────────────────────────────────────────────────────────────
    await q.query(`
      UPDATE billing_invoices SET status = CASE
        WHEN status IN ('PARTIALLY_PAID','DISPUTED') THEN 'ISSUED'
        WHEN status = 'VOID' THEN 'CANCELLED'
        ELSE status END
       WHERE status NOT IN ('DRAFT','ISSUED','PAID','CANCELLED')
    `);
    await q.query(`ALTER TABLE "billing_invoices" DROP COLUMN IF EXISTS "type"`);
    await q.query(`ALTER TABLE "billing_invoices" DROP COLUMN IF EXISTS "discount_amount"`);
    await q.query(`ALTER TABLE "billing_invoices" DROP CONSTRAINT IF EXISTS "CK_billing_invoices_status"`);
    await q.query(`
      ALTER TABLE "billing_invoices"
        ADD CONSTRAINT "CK_billing_invoices_status"
        CHECK (status IN ('DRAFT','ISSUED','PAID','CANCELLED'))
    `);

    // ── billing_payments ─────────────────────────────────────────────────────────────────
    await q.query(`ALTER TABLE "billing_payments" DROP COLUMN IF EXISTS "status"`);
    await q.query(`ALTER TABLE "billing_payments" DROP COLUMN IF EXISTS "allocated_to_entry_ids"`);
    await q.query(`ALTER TABLE "billing_payments" DROP CONSTRAINT IF EXISTS "CK_billing_payments_amount_positive"`);
    await q.query(`
      ALTER TABLE "billing_payments"
        ADD CONSTRAINT "CK_billing_payments_amount_positive" CHECK (amount > 0)
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_payments_inbound_ref"
        ON "billing_payments" ("invoice_id", "payment_reference")
        WHERE direction = 'INBOUND' AND invoice_id IS NOT NULL AND is_active = true
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_payments_outbound_ref"
        ON "billing_payments" ("payable_id", "payment_reference")
        WHERE direction = 'OUTBOUND' AND payable_id IS NOT NULL AND is_active = true
    `);

    // ── gone for good ────────────────────────────────────────────────────────────────────
    await q.query(`DROP TABLE IF EXISTS "billing_conflicts"`);
    await q.query(`DROP TABLE IF EXISTS "client_billing_history"`);
    await q.query(`ALTER TABLE "client_billing" DROP COLUMN IF EXISTS "status"`);
    await q.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "total_earnings"`);
  }

  /** Structure only. The collapsed states and deleted rows are not recoverable, by design. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "assayers" ADD COLUMN IF NOT EXISTS "total_earnings" numeric(14,2) NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "client_billing" ADD COLUMN IF NOT EXISTS "status" character varying(20) NOT NULL DEFAULT 'DRAFT'`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "client_billing_history" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true, "client_id" uuid NOT NULL,
        "event_type" character varying(30) NOT NULL, "from_status" character varying(20),
        "to_status" character varying(20), "remarks" text, "field" character varying(100),
        "from_value" text, "to_value" text,
        CONSTRAINT "PK_7fbae248c34f1b3218e226fcf59" PRIMARY KEY ("id"))
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "billing_conflicts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true, "conflict_number" character varying(50) NOT NULL,
        "severity" character varying(20) NOT NULL DEFAULT 'WARNING', "entity_type" character varying(20) NOT NULL,
        "entry_ids" jsonb NOT NULL, "description" text NOT NULL, "reason" text, "created_by_id" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'OPEN', "resolution_action" character varying(20),
        "resolution_note" text, "resolved_by" uuid, "resolved_at" TIMESTAMP WITH TIME ZONE,
        "blocks_billing" boolean NOT NULL DEFAULT false,
        CONSTRAINT "UQ_186cd8f16a7d945d8b7625875fd" UNIQUE ("conflict_number"),
        CONSTRAINT "PK_eeb13293df6d2dee66e267fc882" PRIMARY KEY ("id"))
    `);

    await q.query(`DROP INDEX IF EXISTS "UQ_billing_payments_outbound_ref"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_billing_payments_inbound_ref"`);
    await q.query(`ALTER TABLE "billing_payments" DROP CONSTRAINT IF EXISTS "CK_billing_payments_amount_positive"`);
    await q.query(`ALTER TABLE "billing_payments" ADD COLUMN IF NOT EXISTS "allocated_to_entry_ids" jsonb`);
    await q.query(`ALTER TABLE "billing_payments" ADD COLUMN IF NOT EXISTS "status" character varying(20) NOT NULL DEFAULT 'RECEIVED'`);

    await q.query(`ALTER TABLE "billing_invoices" DROP CONSTRAINT IF EXISTS "CK_billing_invoices_status"`);
    await q.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "discount_amount" numeric(14,2) NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "type" character varying(20) NOT NULL DEFAULT 'PER_PROJECT'`);

    await q.query(`ALTER TABLE "assayer_payables" DROP CONSTRAINT IF EXISTS "CK_assayer_payables_status"`);
    await q.query(`ALTER TABLE "assayer_payables" DROP CONSTRAINT IF EXISTS "FK_assayer_payables_expense"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_assayer_payables_expense"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_assayer_payables_fee_per_assignment"`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_assayer_payables_fee_per_assignment"
        ON "assayer_payables" ("assignment_id")
        WHERE "assignment_id" IS NOT NULL AND ("rate_snapshot"->>'source') IS DISTINCT FROM 'EXPENSE_CLAIM'
    `);
    await q.query(`ALTER TABLE "assayer_payables" ALTER COLUMN "assignment_id" DROP NOT NULL`);
    await q.query(`ALTER TABLE "assayer_payables" DROP COLUMN IF EXISTS "expense_id"`);
    await q.query(`ALTER TABLE "assayer_payables" DROP COLUMN IF EXISTS "hold_reason"`);
    await q.query(`ALTER TABLE "assayer_payables" DROP COLUMN IF EXISTS "on_hold"`);

    await q.query(`DROP INDEX IF EXISTS "UQ_billing_entries_root_per_assignment"`);
    await q.query(`ALTER TABLE "billing_entries" DROP CONSTRAINT IF EXISTS "CK_billing_entries_state"`);
    await q.query(`ALTER TABLE "billing_entries" DROP CONSTRAINT IF EXISTS "FK_fbfd558dd94f3f65e86803e7fe9"`);
    await q.query(`ALTER TABLE "billing_entries" ALTER COLUMN "assignment_id" DROP NOT NULL`);
    await q.query(`
      ALTER TABLE "billing_entries"
        ADD CONSTRAINT "FK_fbfd558dd94f3f65e86803e7fe9"
        FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE SET NULL
    `);
    await q.query(`ALTER TABLE "billing_entries" ALTER COLUMN "state" DROP DEFAULT`);
    for (const [col, ddl] of [
      ['level', `character varying(20) NOT NULL DEFAULT 'ASSIGNMENT'`],
      ['payment_state', `character varying(20) NOT NULL DEFAULT 'UNPAID'`],
      ['pricing_model', `character varying(30) NOT NULL DEFAULT 'FLAT_RATE'`],
      ['rate', `numeric(14,2)`],
      ['quantity', `numeric(14,2)`],
      ['billing_period_start', `date`],
      ['discount_amount', `numeric(14,2) NOT NULL DEFAULT 0`],
      ['billed_amount', `numeric(14,2) NOT NULL DEFAULT 0`],
      ['disputed_amount', `numeric(14,2) NOT NULL DEFAULT 0`],
      ['cancelled_amount', `numeric(14,2) NOT NULL DEFAULT 0`],
      ['adjusted_amount', `numeric(14,2) NOT NULL DEFAULT 0`],
      ['parent_entry_id', `uuid`],
      ['source_entry_id', `uuid`],
    ] as const) {
      await q.query(`ALTER TABLE "billing_entries" ADD COLUMN IF NOT EXISTS "${col}" ${ddl}`);
    }
    await q.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'billing_entries' AND column_name = 'service_date')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'billing_entries' AND column_name = 'billing_period_end') THEN
          ALTER TABLE "billing_entries" RENAME COLUMN "service_date" TO "billing_period_end";
        END IF;
      END $$;
    `);
    await q.query(`ALTER TABLE "billing_entries" DROP COLUMN IF EXISTS "adjustment_reason"`);
    await q.query(`ALTER TABLE "billing_entries" DROP COLUMN IF EXISTS "hold_reason"`);
    await q.query(`ALTER TABLE "billing_entries" DROP COLUMN IF EXISTS "on_hold"`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_entries_root_per_assignment"
        ON "billing_entries" ("assignment_id")
        WHERE "assignment_id" IS NOT NULL AND "parent_entry_id" IS NULL
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_2e1b11d26d549df02511f8fd30" ON "billing_entries" ("level")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_6944cc76f6c31fbb6c9c321178" ON "billing_entries" ("payment_state")`);
  }
}

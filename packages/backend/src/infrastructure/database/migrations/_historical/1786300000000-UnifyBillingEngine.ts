import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Collapses three parallel money systems into the billing engine.
 *
 * Before this, the same assayer payment could be recorded three ways:
 *   - `assayer_payables`         (billing engine, raised on assignment completion)
 *   - `assayer_billing_records`  (legacy billing module, raised on audit close,
 *                                 with GST/TDS hardcoded at 18%/10%)
 *   - `assayer_financial_ledger` (legacy ledger module, a running balance credited
 *                                 by audit close and reconciled to nothing)
 *
 * `closeAudit` wrote to the latter two while assignment completion wrote to the
 * first, so a completed-and-closed job produced two independent obligations for
 * one piece of work. All three legacy tables were empty in every environment
 * checked (the audit-close path had never run), so this drops them rather than
 * attempting a merge — verified before writing this migration.
 *
 * Payments become bidirectional so that money in (client invoices) and money out
 * (assayer disbursements) share one table, which is what makes cash-flow and an
 * assayer's running balance answerable from a single query.
 */
export class UnifyBillingEngine1786300000000 implements MigrationInterface {
  name = 'UnifyBillingEngine1786300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Payments carry both directions ─────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE billing_payments
        ADD COLUMN IF NOT EXISTS direction varchar(10) NOT NULL DEFAULT 'INBOUND',
        ADD COLUMN IF NOT EXISTS payable_id uuid,
        ADD COLUMN IF NOT EXISTS assayer_id uuid,
        ADD COLUMN IF NOT EXISTS running_balance numeric(14,2)
    `);

    // An outbound disbursement has no client invoice behind it.
    await queryRunner.query(`ALTER TABLE billing_payments ALTER COLUMN invoice_id DROP NOT NULL`);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_billing_payments_direction" ON billing_payments (direction)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_billing_payments_payable" ON billing_payments (payable_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_billing_payments_assayer" ON billing_payments (assayer_id)
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE billing_payments
          ADD CONSTRAINT "FK_billing_payments_payable"
          FOREIGN KEY (payable_id) REFERENCES assayer_payables(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── Retire the parallel systems ────────────────────────────────────────
    // Guarded: refuses to drop anything that unexpectedly holds data, so this
    // cannot silently destroy money records in an environment that did use them.
    for (const table of ['assayer_billing_records', 'assayer_financial_ledger']) {
      const rows = await queryRunner.query(
        `SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${table}`],
      );
      if (!rows?.[0]?.present) continue;
      const count = await queryRunner.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      if (count?.[0]?.n > 0) {
        throw new Error(
          `Refusing to drop ${table}: it holds ${count[0].n} row(s). Migrate them into ` +
          `assayer_payables / billing_payments before re-running this migration.`,
        );
      }
      await queryRunner.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }

    // The ledger's running balance now derives from real payables, so the stale
    // denormalised counter on the assayer is removed.
    await queryRunner.query(`ALTER TABLE assayers DROP COLUMN IF EXISTS running_balance`);

    // ── Finance role + billing permissions ─────────────────────────────────
    await queryRunner.query(`
      INSERT INTO roles (name, display_name, description, version, is_active, created_by, updated_by)
      SELECT 'FINANCE_MANAGER'::varchar, 'Finance Manager'::varchar,
             'Owns receivables, payables, invoicing and financial reporting.'::varchar,
             1, true, 'SYSTEM'::varchar, 'SYSTEM'::varchar
      WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'FINANCE_MANAGER')
    `);

    const billingPermissions: Array<[string, string]> = [
      ['VIEW', 'PLATFORM'],
      ['CREATE', 'ORGANIZATION'],
      ['EDIT', 'ORGANIZATION'],
      ['APPROVE', 'ORGANIZATION'],
      ['CANCEL', 'ORGANIZATION'],
      ['EXPORT', 'ORGANIZATION'],
    ];
    for (const [action, scope] of billingPermissions) {
      await queryRunner.query(
        `INSERT INTO permissions (resource, action, scope, description, version, is_active, created_by, updated_by)
         SELECT 'BILLING'::varchar, $1::varchar, $2::varchar, $3::varchar, 1, true, 'SYSTEM'::varchar, 'SYSTEM'::varchar
         WHERE NOT EXISTS (
           SELECT 1 FROM permissions WHERE resource = 'BILLING' AND action = $1::varchar AND scope = $2::varchar
         )`,
        [action, scope, `Billing ${action.toLowerCase()} (${scope.toLowerCase()})`],
      );
    }

    // Finance and administrators get the full set; operations keeps the ability to
    // raise and view billing lines but not to approve money movement.
    const grants: Array<[string, string[]]> = [
      ['SUPER_ADMINISTRATOR', ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'CANCEL', 'EXPORT']],
      ['ADMINISTRATOR', ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'CANCEL', 'EXPORT']],
      ['FINANCE_MANAGER', ['VIEW', 'CREATE', 'EDIT', 'APPROVE', 'CANCEL', 'EXPORT']],
      ['OPERATIONS_MANAGER', ['VIEW', 'CREATE', 'EDIT']],
      ['OPERATIONS_EXECUTIVE', ['VIEW']],
    ];
    for (const [roleName, actions] of grants) {
      for (const action of actions) {
        await queryRunner.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT r.id, p.id
             FROM roles r, permissions p
            WHERE r.name = $1::varchar
              AND p.resource = 'BILLING' AND p.action = $2::varchar
              AND NOT EXISTS (
                SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
              )`,
          [roleName, action],
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permissions
       WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'BILLING')
    `);
    await queryRunner.query(`DELETE FROM permissions WHERE resource = 'BILLING'`);
    await queryRunner.query(`DELETE FROM roles WHERE name = 'FINANCE_MANAGER'`);

    await queryRunner.query(`ALTER TABLE assayers ADD COLUMN IF NOT EXISTS running_balance numeric(14,2) DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE billing_payments DROP CONSTRAINT IF EXISTS "FK_billing_payments_payable"`);
    await queryRunner.query(`
      ALTER TABLE billing_payments
        DROP COLUMN IF EXISTS running_balance,
        DROP COLUMN IF EXISTS assayer_id,
        DROP COLUMN IF EXISTS payable_id,
        DROP COLUMN IF EXISTS direction
    `);
    // The dropped legacy tables are intentionally not recreated: they were empty
    // and their responsibilities now live in assayer_payables / billing_payments.
  }
}

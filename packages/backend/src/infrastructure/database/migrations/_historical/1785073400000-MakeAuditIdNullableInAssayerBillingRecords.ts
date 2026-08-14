import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Relaxes a NOT NULL on a legacy table — if that table is here at all.
 *
 * `assayer_billing_records` was never created by any migration. It existed only on databases
 * built by `synchronize`, and `UnifyBillingEngine` (1786300000000) later drops it as legacy. So
 * on a database built the way production must be built — migrations from empty — this ran against
 * a table that had never existed and aborted the whole run at migration 9 of 64.
 *
 * That is why the migration chain had never been executed end to end: it could not be. Guarded
 * with `to_regclass`, it is a no-op on a fresh database and unchanged on an existing one.
 */
export class MakeAuditIdNullableInAssayerBillingRecords1785073400000 implements MigrationInterface {
  name = 'MakeAuditIdNullableInAssayerBillingRecords1785073400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.assayer_billing_records') IS NOT NULL THEN
          ALTER TABLE "assayer_billing_records" ALTER COLUMN "auditId" DROP NOT NULL;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.assayer_billing_records') IS NOT NULL THEN
          ALTER TABLE "assayer_billing_records" ALTER COLUMN "auditId" SET NOT NULL;
        END IF;
      END $$;
    `);
  }
}

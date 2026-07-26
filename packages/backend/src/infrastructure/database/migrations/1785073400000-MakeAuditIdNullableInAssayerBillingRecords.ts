import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeAuditIdNullableInAssayerBillingRecords1785073400000 implements MigrationInterface {
  name = 'MakeAuditIdNullableInAssayerBillingRecords1785073400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assayer_billing_records" ALTER COLUMN "auditId" DROP NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assayer_billing_records" ALTER COLUMN "auditId" SET NOT NULL`
    );
  }
}

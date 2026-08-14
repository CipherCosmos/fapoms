import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRunningBalanceToAssayers1785073900000 implements MigrationInterface {
  name = 'AddRunningBalanceToAssayers1785073900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assayers" ADD COLUMN IF NOT EXISTS "running_balance" numeric(14,2) NOT NULL DEFAULT 0`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assayers" DROP COLUMN IF EXISTS "running_balance"`
    );
  }
}

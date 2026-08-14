import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveRedundantAssayerJsonbColumns1784693000000 implements MigrationInterface {
    name = 'RemoveRedundantAssayerJsonbColumns1784693000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "skills"`);
        await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "certifications"`);
        await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "languages"`);
        await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "specializations"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "assayers" ADD "skills" jsonb`);
        await queryRunner.query(`ALTER TABLE "assayers" ADD "certifications" jsonb`);
        await queryRunner.query(`ALTER TABLE "assayers" ADD "languages" jsonb`);
        await queryRunner.query(`ALTER TABLE "assayers" ADD "specializations" jsonb`);
    }
}

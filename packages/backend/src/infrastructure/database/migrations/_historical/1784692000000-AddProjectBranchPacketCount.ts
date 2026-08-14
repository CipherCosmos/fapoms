import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProjectBranchPacketCount1784692000000 implements MigrationInterface {
    name = 'AddProjectBranchPacketCount1784692000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "project_branches" ADD "packet_count" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "project_branches" DROP COLUMN "packet_count"`);
    }
}

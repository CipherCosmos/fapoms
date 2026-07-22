import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAssignmentSlaFields1784691938516 implements MigrationInterface {
    name = 'AddAssignmentSlaFields1784691938516'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "assignments" ADD "sla_due_date" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "assignments" ADD "sla_status" character varying(50) NOT NULL DEFAULT 'COMPLIANT'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN "sla_status"`);
        await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN "sla_due_date"`);
    }

}

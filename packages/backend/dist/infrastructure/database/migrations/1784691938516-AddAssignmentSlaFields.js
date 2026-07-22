"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddAssignmentSlaFields1784691938516 = void 0;
class AddAssignmentSlaFields1784691938516 {
    name = 'AddAssignmentSlaFields1784691938516';
    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "assignments" ADD "sla_due_date" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "assignments" ADD "sla_status" character varying(50) NOT NULL DEFAULT 'COMPLIANT'`);
    }
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN "sla_status"`);
        await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN "sla_due_date"`);
    }
}
exports.AddAssignmentSlaFields1784691938516 = AddAssignmentSlaFields1784691938516;
//# sourceMappingURL=1784691938516-AddAssignmentSlaFields.js.map
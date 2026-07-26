"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddProjectBranchPacketCount1784692000000 = void 0;
class AddProjectBranchPacketCount1784692000000 {
    name = 'AddProjectBranchPacketCount1784692000000';
    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "project_branches" ADD "packet_count" integer`);
    }
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "project_branches" DROP COLUMN "packet_count"`);
    }
}
exports.AddProjectBranchPacketCount1784692000000 = AddProjectBranchPacketCount1784692000000;
//# sourceMappingURL=1784692000000-AddProjectBranchPacketCount.js.map
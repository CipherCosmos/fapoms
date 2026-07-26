"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoveRedundantAssayerJsonbColumns1784693000000 = void 0;
class RemoveRedundantAssayerJsonbColumns1784693000000 {
    name = 'RemoveRedundantAssayerJsonbColumns1784693000000';
    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "skills"`);
        await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "certifications"`);
        await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "languages"`);
        await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "specializations"`);
    }
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "assayers" ADD "skills" jsonb`);
        await queryRunner.query(`ALTER TABLE "assayers" ADD "certifications" jsonb`);
        await queryRunner.query(`ALTER TABLE "assayers" ADD "languages" jsonb`);
        await queryRunner.query(`ALTER TABLE "assayers" ADD "specializations" jsonb`);
    }
}
exports.RemoveRedundantAssayerJsonbColumns1784693000000 = RemoveRedundantAssayerJsonbColumns1784693000000;
//# sourceMappingURL=1784693000000-RemoveRedundantAssayerJsonbColumns.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CorrectEntitySchemaMismatches1784654900000 = void 0;
class CorrectEntitySchemaMismatches1784654900000 {
    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "assayer_government_documents" ALTER COLUMN "verified_by" TYPE uuid USING NULLIF(verified_by, '')::uuid`);
        await queryRunner.query(`ALTER TABLE "assayer_remarks" ALTER COLUMN "author_id" TYPE uuid USING NULLIF(author_id, '')::uuid`);
        await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "emergency_contact_name" TYPE varchar(200)`);
        await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "emergency_contact_relation" TYPE varchar(100)`);
        await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "employee_id" TYPE varchar(50)`);
        await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "employee_code" TYPE varchar(50)`);
        await queryRunner.query(`ALTER TABLE "assayer_government_documents" ALTER COLUMN "document_type" TYPE varchar(50)`);
        await queryRunner.query(`ALTER TABLE "assayer_government_documents" ALTER COLUMN "expiry_date" TYPE date USING expiry_date::date`);
        await queryRunner.query(`ALTER TABLE "assayer_documents" ALTER COLUMN "document_type" TYPE varchar(50)`);
    }
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "assayer_documents" ALTER COLUMN "document_type" TYPE varchar(100)`);
        await queryRunner.query(`ALTER TABLE "assayer_government_documents" ALTER COLUMN "expiry_date" TYPE timestamptz USING expiry_date::timestamptz`);
        await queryRunner.query(`ALTER TABLE "assayer_government_documents" ALTER COLUMN "document_type" TYPE varchar(100)`);
        await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "employee_code" TYPE varchar(100)`);
        await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "employee_id" TYPE varchar(100)`);
        await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "emergency_contact_relation" TYPE varchar(50)`);
        await queryRunner.query(`ALTER TABLE "assayers" ALTER COLUMN "emergency_contact_name" TYPE varchar(150)`);
        await queryRunner.query(`ALTER TABLE "assayer_remarks" ALTER COLUMN "author_id" TYPE varchar(150)`);
        await queryRunner.query(`ALTER TABLE "assayer_government_documents" ALTER COLUMN "verified_by" TYPE varchar(150)`);
    }
}
exports.CorrectEntitySchemaMismatches1784654900000 = CorrectEntitySchemaMismatches1784654900000;
//# sourceMappingURL=1784654900000-CorrectEntitySchemaMismatches.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddOcrBoundaryJobs1784654125144 = void 0;
class AddOcrBoundaryJobs1784654125144 {
    name = 'AddOcrBoundaryJobs1784654125144';
    async up(queryRunner) {
        await queryRunner.query(`CREATE TYPE "public"."ocr_jobs_status_enum" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')`);
        await queryRunner.query(`CREATE TABLE "ocr_jobs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "document_id" uuid NOT NULL, "external_job_id" character varying(150), "status" "public"."ocr_jobs_status_enum" NOT NULL DEFAULT 'PENDING', "ocr_payload" jsonb, "retry_count" integer NOT NULL DEFAULT '0', "failure_reason" text, CONSTRAINT "PK_ef6e873087a3947edfb3f2499cc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_06773ea0f2d7b15d52f8427886" ON "ocr_jobs" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_3983a5b63b73ffa78f41131eb5" ON "ocr_jobs" ("document_id") `);
        await queryRunner.query(`ALTER TABLE "ocr_jobs" ADD CONSTRAINT "FK_3983a5b63b73ffa78f41131eb58" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "ocr_jobs" DROP CONSTRAINT "FK_3983a5b63b73ffa78f41131eb58"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3983a5b63b73ffa78f41131eb5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_06773ea0f2d7b15d52f8427886"`);
        await queryRunner.query(`DROP TABLE "ocr_jobs"`);
        await queryRunner.query(`DROP TYPE "public"."ocr_jobs_status_enum"`);
    }
}
exports.AddOcrBoundaryJobs1784654125144 = AddOcrBoundaryJobs1784654125144;
//# sourceMappingURL=1784654125144-AddOcrBoundaryJobs.js.map
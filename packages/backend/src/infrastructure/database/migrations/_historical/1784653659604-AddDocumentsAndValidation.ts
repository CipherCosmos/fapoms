import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDocumentsAndValidation1784653659604 implements MigrationInterface {
    name = 'AddDocumentsAndValidation1784653659604'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."validation_cases_status_enum" AS ENUM('PENDING', 'ASSIGNED', 'OCR_PROCESSING', 'HUMAN_REVIEW', 'CORRECTION_REQUIRED', 'APPROVED', 'SUBMITTED')`);
        await queryRunner.query(`CREATE TABLE "validation_cases" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "project_branch_id" uuid NOT NULL, "status" "public"."validation_cases_status_enum" NOT NULL DEFAULT 'PENDING', "ocr_result" jsonb, "reviewer_id" uuid, "reviewed_at" TIMESTAMP WITH TIME ZONE, "remarks" text, "correction_notes" text, CONSTRAINT "PK_1b1c0e9fdf43b9de6e8c96a9070" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3b7b6f62b3e3eddbdb96ad306d" ON "validation_cases" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_8e9beb6c37bfcfbcf682527494" ON "validation_cases" ("project_branch_id") `);
        await queryRunner.query(`CREATE TYPE "public"."documents_type_enum" AS ENUM('BRANCH_LIST', 'CUSTOMER_MASTER_DATA', 'GENERATED_PDF', 'RETURNED_AUDIT_PDF', 'GENERATED_EXCEL', 'FINAL_REPORT')`);
        await queryRunner.query(`CREATE TYPE "public"."documents_status_enum" AS ENUM('UPLOADED', 'PROCESSED', 'GENERATED', 'DISPATCHED', 'RECEIVED', 'ARCHIVED')`);
        await queryRunner.query(`CREATE TABLE "documents" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "project_branch_id" uuid NOT NULL, "file_name" character varying(255) NOT NULL, "file_path" text NOT NULL, "file_size" integer NOT NULL, "mime_type" character varying(100), "type" "public"."documents_type_enum" NOT NULL, "status" "public"."documents_status_enum" NOT NULL DEFAULT 'UPLOADED', "doc_version" integer NOT NULL DEFAULT '1', CONSTRAINT "PK_ac51aa5181ee2036f5ca482857c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_66f0789287cc73ca31dcefd5e4" ON "documents" ("type") `);
        await queryRunner.query(`CREATE INDEX "IDX_709389d904fa03bdf5ec84998d" ON "documents" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_98d558b1357496cd28e94bff5a" ON "documents" ("project_branch_id") `);
        await queryRunner.query(`ALTER TABLE "validation_cases" ADD CONSTRAINT "FK_8e9beb6c37bfcfbcf6825274947" FOREIGN KEY ("project_branch_id") REFERENCES "project_branches"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "documents" ADD CONSTRAINT "FK_98d558b1357496cd28e94bff5a6" FOREIGN KEY ("project_branch_id") REFERENCES "project_branches"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "documents" DROP CONSTRAINT "FK_98d558b1357496cd28e94bff5a6"`);
        await queryRunner.query(`ALTER TABLE "validation_cases" DROP CONSTRAINT "FK_8e9beb6c37bfcfbcf6825274947"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_98d558b1357496cd28e94bff5a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_709389d904fa03bdf5ec84998d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_66f0789287cc73ca31dcefd5e4"`);
        await queryRunner.query(`DROP TABLE "documents"`);
        await queryRunner.query(`DROP TYPE "public"."documents_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."documents_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8e9beb6c37bfcfbcf682527494"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3b7b6f62b3e3eddbdb96ad306d"`);
        await queryRunner.query(`DROP TABLE "validation_cases"`);
        await queryRunner.query(`DROP TYPE "public"."validation_cases_status_enum"`);
    }

}

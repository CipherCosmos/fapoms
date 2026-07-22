"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddAssignmentExpansion1784691896666 = void 0;
class AddAssignmentExpansion1784691896666 {
    name = 'AddAssignmentExpansion1784691896666';
    async up(queryRunner) {
        await queryRunner.query(`CREATE TABLE "assignment_comments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "assignment_id" uuid NOT NULL, "user_id" uuid NOT NULL, "user_name" character varying(255) NOT NULL, "comment" text NOT NULL, CONSTRAINT "PK_99976f728e0bca8642be0f2bec7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_0903a7b0ed62fb4399c32004dd" ON "assignment_comments" ("assignment_id") `);
        await queryRunner.query(`CREATE TYPE "public"."assignments_priority_enum" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')`);
        await queryRunner.query(`ALTER TABLE "assignments" ADD "priority" "public"."assignments_priority_enum" NOT NULL DEFAULT 'MEDIUM'`);
        await queryRunner.query(`ALTER TABLE "assignments" DROP CONSTRAINT "FK_66969a729f0c24ff71d5ba18c43"`);
        await queryRunner.query(`ALTER TABLE "assignments" DROP CONSTRAINT "REL_66969a729f0c24ff71d5ba18c4"`);
        await queryRunner.query(`ALTER TABLE "assignments" ADD CONSTRAINT "FK_66969a729f0c24ff71d5ba18c43" FOREIGN KEY ("project_branch_id") REFERENCES "project_branches"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "assignment_comments" ADD CONSTRAINT "FK_0903a7b0ed62fb4399c32004dd0" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "assignment_comments" DROP CONSTRAINT "FK_0903a7b0ed62fb4399c32004dd0"`);
        await queryRunner.query(`ALTER TABLE "assignments" DROP CONSTRAINT "FK_66969a729f0c24ff71d5ba18c43"`);
        await queryRunner.query(`ALTER TABLE "assignments" ADD CONSTRAINT "REL_66969a729f0c24ff71d5ba18c4" UNIQUE ("project_branch_id")`);
        await queryRunner.query(`ALTER TABLE "assignments" ADD CONSTRAINT "FK_66969a729f0c24ff71d5ba18c43" FOREIGN KEY ("project_branch_id") REFERENCES "project_branches"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "assignments" DROP COLUMN "priority"`);
        await queryRunner.query(`DROP TYPE "public"."assignments_priority_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0903a7b0ed62fb4399c32004dd"`);
        await queryRunner.query(`DROP TABLE "assignment_comments"`);
    }
}
exports.AddAssignmentExpansion1784691896666 = AddAssignmentExpansion1784691896666;
//# sourceMappingURL=1784691896666-AddAssignmentExpansion.js.map
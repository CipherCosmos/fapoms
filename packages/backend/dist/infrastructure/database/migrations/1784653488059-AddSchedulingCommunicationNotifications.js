"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddSchedulingCommunicationNotifications1784653488059 = void 0;
class AddSchedulingCommunicationNotifications1784653488059 {
    name = 'AddSchedulingCommunicationNotifications1784653488059';
    async up(queryRunner) {
        await queryRunner.query(`CREATE TYPE "public"."schedules_status_enum" AS ENUM('TENTATIVE', 'CONFIRMED', 'RESCHEDULED', 'COMPLETED')`);
        await queryRunner.query(`CREATE TABLE "schedules" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "assignment_id" uuid NOT NULL, "project_id" uuid NOT NULL, "assayer_id" uuid NOT NULL, "scheduled_date" date NOT NULL, "status" "public"."schedules_status_enum" NOT NULL DEFAULT 'TENTATIVE', "remarks" text, CONSTRAINT "REL_1b1bb2cd81f25ee4761f4b1e0e" UNIQUE ("assignment_id"), CONSTRAINT "PK_7e33fc2ea755a5765e3564e66dd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c76954510b334df511e6011461" ON "schedules" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_967a409cbb41310788ae903514" ON "schedules" ("assayer_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_cff8d47d6171818e64aca8779a" ON "schedules" ("project_id") `);
        await queryRunner.query(`CREATE TABLE "notifications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "user_id" uuid NOT NULL, "title" character varying(255) NOT NULL, "message" text NOT NULL, "is_read" boolean NOT NULL DEFAULT false, "link" character varying(255), CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f12148ce379462ebbb4d06cc13" ON "notifications" ("is_read") `);
        await queryRunner.query(`CREATE INDEX "IDX_9a8a82462cab47c73d25f49261" ON "notifications" ("user_id") `);
        await queryRunner.query(`CREATE TYPE "public"."communications_type_enum" AS ENUM('PHONE', 'WHATSAPP', 'EMAIL', 'SYSTEM')`);
        await queryRunner.query(`CREATE TABLE "communications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "assignment_id" uuid NOT NULL, "type" "public"."communications_type_enum" NOT NULL, "content" text NOT NULL, "initiated_by" uuid NOT NULL, "recipient_ref" character varying(150), "is_delivered" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_29ec793018d5d5ca19d40149e87" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1cf095dc0dc701c3b0a7e02c92" ON "communications" ("type") `);
        await queryRunner.query(`CREATE INDEX "IDX_7863112d98700a0c84a0cd14c3" ON "communications" ("assignment_id") `);
        await queryRunner.query(`ALTER TABLE "schedules" ADD CONSTRAINT "FK_1b1bb2cd81f25ee4761f4b1e0e3" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "schedules" ADD CONSTRAINT "FK_cff8d47d6171818e64aca8779af" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "schedules" ADD CONSTRAINT "FK_967a409cbb41310788ae903514a" FOREIGN KEY ("assayer_id") REFERENCES "assayers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "FK_9a8a82462cab47c73d25f49261f" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "communications" ADD CONSTRAINT "FK_7863112d98700a0c84a0cd14c37" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "communications" DROP CONSTRAINT "FK_7863112d98700a0c84a0cd14c37"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_9a8a82462cab47c73d25f49261f"`);
        await queryRunner.query(`ALTER TABLE "schedules" DROP CONSTRAINT "FK_967a409cbb41310788ae903514a"`);
        await queryRunner.query(`ALTER TABLE "schedules" DROP CONSTRAINT "FK_cff8d47d6171818e64aca8779af"`);
        await queryRunner.query(`ALTER TABLE "schedules" DROP CONSTRAINT "FK_1b1bb2cd81f25ee4761f4b1e0e3"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7863112d98700a0c84a0cd14c3"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1cf095dc0dc701c3b0a7e02c92"`);
        await queryRunner.query(`DROP TABLE "communications"`);
        await queryRunner.query(`DROP TYPE "public"."communications_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9a8a82462cab47c73d25f49261"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f12148ce379462ebbb4d06cc13"`);
        await queryRunner.query(`DROP TABLE "notifications"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cff8d47d6171818e64aca8779a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_967a409cbb41310788ae903514"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c76954510b334df511e6011461"`);
        await queryRunner.query(`DROP TABLE "schedules"`);
        await queryRunner.query(`DROP TYPE "public"."schedules_status_enum"`);
    }
}
exports.AddSchedulingCommunicationNotifications1784653488059 = AddSchedulingCommunicationNotifications1784653488059;
//# sourceMappingURL=1784653488059-AddSchedulingCommunicationNotifications.js.map
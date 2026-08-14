import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDeviceTokens1785074000000 implements MigrationInterface {
    name = 'AddDeviceTokens1785074000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "device_tokens" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "created_by" character varying,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_by" character varying,
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "version" integer NOT NULL DEFAULT 1,
                "is_active" boolean NOT NULL DEFAULT true,
                "user_id" uuid NOT NULL,
                "token" character varying(500) NOT NULL,
                "platform" character varying(10) NOT NULL,
                CONSTRAINT "PK_device_tokens" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_device_tokens_user_platform" ON "device_tokens" ("user_id", "platform")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_device_tokens_token" ON "device_tokens" ("token")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_device_tokens_token"`);
        await queryRunner.query(`DROP INDEX "IDX_device_tokens_user_platform"`);
        await queryRunner.query(`DROP TABLE "device_tokens"`);
    }
}

import { MigrationInterface, QueryRunner } from "typeorm";
export declare class AddSchedulingCommunicationNotifications1784653488059 implements MigrationInterface {
    name: string;
    up(queryRunner: QueryRunner): Promise<void>;
    down(queryRunner: QueryRunner): Promise<void>;
}

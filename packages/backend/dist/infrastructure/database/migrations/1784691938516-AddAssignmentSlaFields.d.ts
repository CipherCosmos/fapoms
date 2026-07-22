import { MigrationInterface, QueryRunner } from "typeorm";
export declare class AddAssignmentSlaFields1784691938516 implements MigrationInterface {
    name: string;
    up(queryRunner: QueryRunner): Promise<void>;
    down(queryRunner: QueryRunner): Promise<void>;
}

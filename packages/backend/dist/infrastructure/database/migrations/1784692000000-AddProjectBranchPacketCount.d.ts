import { MigrationInterface, QueryRunner } from "typeorm";
export declare class AddProjectBranchPacketCount1784692000000 implements MigrationInterface {
    name: string;
    up(queryRunner: QueryRunner): Promise<void>;
    down(queryRunner: QueryRunner): Promise<void>;
}

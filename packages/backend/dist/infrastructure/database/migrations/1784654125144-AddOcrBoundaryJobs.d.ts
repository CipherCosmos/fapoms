import { MigrationInterface, QueryRunner } from "typeorm";
export declare class AddOcrBoundaryJobs1784654125144 implements MigrationInterface {
    name: string;
    up(queryRunner: QueryRunner): Promise<void>;
    down(queryRunner: QueryRunner): Promise<void>;
}

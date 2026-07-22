import { MigrationInterface, QueryRunner } from "typeorm";
export declare class AddProjectOperationalFields1784691660986 implements MigrationInterface {
    name: string;
    up(queryRunner: QueryRunner): Promise<void>;
    down(queryRunner: QueryRunner): Promise<void>;
}

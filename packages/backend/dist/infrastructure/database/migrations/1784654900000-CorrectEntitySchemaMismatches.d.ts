import { MigrationInterface, QueryRunner } from 'typeorm';
export declare class CorrectEntitySchemaMismatches1784654900000 implements MigrationInterface {
    up(queryRunner: QueryRunner): Promise<void>;
    down(queryRunner: QueryRunner): Promise<void>;
}

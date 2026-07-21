import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddWorkforceIntelligenceToAssayers1784654600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('assayers', [
      new TableColumn({
        name: 'employment_type',
        type: 'varchar',
        length: '50',
        default: "'INTERNAL'",
      }),
      new TableColumn({
        name: 'skills',
        type: 'jsonb',
        isNullable: true,
      }),
      new TableColumn({
        name: 'certifications',
        type: 'jsonb',
        isNullable: true,
      }),
      new TableColumn({
        name: 'languages',
        type: 'jsonb',
        isNullable: true,
      }),
      new TableColumn({
        name: 'preferred_regions',
        type: 'jsonb',
        isNullable: true,
      }),
      new TableColumn({
        name: 'specializations',
        type: 'jsonb',
        isNullable: true,
      }),
      new TableColumn({
        name: 'experience_years',
        type: 'int',
        default: 0,
      }),
      new TableColumn({
        name: 'performance_rating',
        type: 'decimal',
        precision: 3,
        scale: 2,
        default: 5.00,
      }),
      new TableColumn({
        name: 'leaves',
        type: 'jsonb',
        isNullable: true,
      }),
      new TableColumn({
        name: 'working_hours',
        type: 'jsonb',
        isNullable: true,
      }),
      new TableColumn({
        name: 'max_daily_workload',
        type: 'int',
        default: 3,
      }),
      new TableColumn({
        name: 'max_weekly_workload',
        type: 'int',
        default: 15,
      }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns('assayers', [
      'employment_type',
      'skills',
      'certifications',
      'languages',
      'preferred_regions',
      'specializations',
      'experience_years',
      'performance_rating',
      'leaves',
      'working_hours',
      'max_daily_workload',
      'max_weekly_workload',
    ]);
  }
}

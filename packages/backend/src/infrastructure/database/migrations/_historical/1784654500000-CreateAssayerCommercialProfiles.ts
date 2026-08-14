import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class CreateAssayerCommercialProfiles1784654500000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'assayer_commercial_profiles',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'uuid_generate_v4()',
          },
          {
            name: 'created_by',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            default: 'now()',
          },
          {
            name: 'updated_by',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'updated_at',
            type: 'timestamptz',
            default: 'now()',
          },
          {
            name: 'version',
            type: 'int',
            default: 1,
          },
          {
            name: 'is_active',
            type: 'boolean',
            default: true,
          },
          {
            name: 'assayer_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'base_fee',
            type: 'decimal',
            precision: 12,
            scale: 2,
            default: 0,
          },
          {
            name: 'hourly_rate',
            type: 'decimal',
            precision: 12,
            scale: 2,
            default: 0,
          },
          {
            name: 'daily_rate',
            type: 'decimal',
            precision: 12,
            scale: 2,
            default: 0,
          },
          {
            name: 'travel_reimbursement',
            type: 'decimal',
            precision: 12,
            scale: 2,
            default: 0,
          },
          {
            name: 'accommodation_allowance',
            type: 'decimal',
            precision: 12,
            scale: 2,
            default: 0,
          },
          {
            name: 'meal_allowance',
            type: 'decimal',
            precision: 12,
            scale: 2,
            default: 0,
          },
          {
            name: 'currency',
            type: 'varchar',
            length: '10',
            default: "'INR'",
          },
          {
            name: 'effective_start_date',
            type: 'timestamptz',
            isNullable: false,
          },
          {
            name: 'effective_end_date',
            type: 'timestamptz',
            isNullable: true,
          },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'assayer_commercial_profiles',
      new TableForeignKey({
        columnNames: ['assayer_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'assayers',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'assayer_commercial_profiles',
      new TableIndex({
        name: 'IDX_COMMERCIAL_PROFILE_ASSAYER',
        columnNames: ['assayer_id'],
      }),
    );

    await queryRunner.createIndex(
      'assayer_commercial_profiles',
      new TableIndex({
        name: 'IDX_COMMERCIAL_PROFILE_EFFECTIVE',
        columnNames: ['effective_start_date', 'effective_end_date'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('assayer_commercial_profiles');
  }
}

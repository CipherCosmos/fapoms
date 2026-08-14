import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex, TableColumn } from 'typeorm';

export class EnterpriseIntelligenceAndRuleEngine1784654700000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create workforce_attributes table
    await queryRunner.createTable(
      new Table({
        name: 'workforce_attributes',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'uuid_generate_v4()' },
          { name: 'created_by', type: 'varchar', isNullable: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_by', type: 'varchar', isNullable: true },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
          { name: 'version', type: 'int', default: 1 },
          { name: 'is_active', type: 'boolean', default: true },
          { name: 'assayer_id', type: 'uuid', isNullable: false },
          { name: 'type', type: 'varchar', length: '50' }, // 'SKILL', 'CERTIFICATION', 'LANGUAGE'
          { name: 'name', type: 'varchar', length: '150' },
          { name: 'level', type: 'varchar', length: '50', isNullable: true },
          { name: 'expiry_date', type: 'timestamptz', isNullable: true },
          { name: 'metadata', type: 'jsonb', isNullable: true },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'workforce_attributes',
      new TableForeignKey({
        columnNames: ['assayer_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'assayers',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'workforce_attributes',
      new TableIndex({
        name: 'IDX_WORKFORCE_ATTRIBUTES_ASSAYER',
        columnNames: ['assayer_id'],
      }),
    );

    // 2. Create business_rules table
    await queryRunner.createTable(
      new Table({
        name: 'business_rules',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'uuid_generate_v4()' },
          { name: 'created_by', type: 'varchar', isNullable: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_by', type: 'varchar', isNullable: true },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
          { name: 'version', type: 'int', default: 1 },
          { name: 'is_active', type: 'boolean', default: true },
          { name: 'name', type: 'varchar', length: '150' },
          { name: 'scope', type: 'varchar', length: '50' }, // 'GLOBAL', 'CLIENT', 'BRANCH'
          { name: 'target_id', type: 'uuid', isNullable: true },
          { name: 'rule_type', type: 'varchar', length: '100' }, // 'ELIGIBILITY', 'CAPACITY', 'CERTIFICATION', 'TERRITORY'
          { name: 'conditions', type: 'jsonb' },
          { name: 'actions', type: 'jsonb', isNullable: true },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'business_rules',
      new TableIndex({
        name: 'IDX_BUSINESS_RULES_SCOPE',
        columnNames: ['scope', 'target_id'],
      }),
    );

    // 3. Extend clients with priority, budget, preferred/restricted assayers, planning preferences
    await queryRunner.addColumns('clients', [
      new TableColumn({ name: 'priority', type: 'varchar', length: '50', default: "'MEDIUM'" }),
      new TableColumn({ name: 'budget', type: 'decimal', precision: 12, scale: 2, isNullable: true }),
      new TableColumn({ name: 'preferred_assayers', type: 'jsonb', isNullable: true }),
      new TableColumn({ name: 'restricted_assayers', type: 'jsonb', isNullable: true }),
      new TableColumn({ name: 'planning_preferences', type: 'jsonb', isNullable: true }),
    ]);

    // 4. Extend branches with risk score, audit complexity, estimated duration, required competencies
    await queryRunner.addColumns('branches', [
      new TableColumn({ name: 'risk_score', type: 'decimal', precision: 5, scale: 2, default: 0.00 }),
      new TableColumn({ name: 'complexity', type: 'varchar', length: '50', default: "'STANDARD'" }),
      new TableColumn({ name: 'estimated_duration_hours', type: 'decimal', precision: 5, scale: 2, default: 8.00 }),
      new TableColumn({ name: 'required_competencies', type: 'jsonb', isNullable: true }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns('branches', [
      'risk_score',
      'complexity',
      'estimated_duration_hours',
      'required_competencies',
    ]);
    await queryRunner.dropColumns('clients', [
      'priority',
      'budget',
      'preferred_assayers',
      'restricted_assayers',
      'planning_preferences',
    ]);
    await queryRunner.dropTable('business_rules');
    await queryRunner.dropTable('workforce_attributes');
  }
}

import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex, TableColumn } from 'typeorm';

export class AddOrganizationsAndAssayerEnterprise1784654800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 0. Pre-cleanup: drop pre-existing columns that may have been added manually
    const tablesWithOrg = ['users', 'clients', 'branches', 'projects', 'assayers'];
    for (const table of tablesWithOrg) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "organization_id"`);
    }
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "department_id"`);

    // Drop pre-existing enterprise assayer columns if any
    const assayerCols = ['employee_id', 'employee_code', 'manager_id', 'department', 'region',
      'joining_date', 'exit_date', 'termination_date', 'lifecycle_status',
      'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation', 'photograph'];
    for (const col of assayerCols) {
      await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "${col}"`);
    }

    // 1. Create organizations table
    await queryRunner.createTable(
      new Table({
        name: 'organizations',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'uuid_generate_v4()' },
          { name: 'created_by', type: 'varchar', isNullable: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_by', type: 'varchar', isNullable: true },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
          { name: 'version', type: 'int', default: 1 },
          { name: 'is_active', type: 'boolean', default: true },
          { name: 'name', type: 'varchar', length: '200', isNullable: false },
          { name: 'code', type: 'varchar', length: '50', isNullable: false },
          { name: 'display_name', type: 'varchar', length: '200', isNullable: true },
          { name: 'description', type: 'text', isNullable: true },
          { name: 'address', type: 'text', isNullable: true },
          { name: 'contact_email', type: 'varchar', length: '150', isNullable: true },
          { name: 'contact_phone', type: 'varchar', length: '20', isNullable: true },
          { name: 'tax_id', type: 'varchar', length: '50', isNullable: true },
          { name: 'registration_number', type: 'varchar', length: '50', isNullable: true },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'organizations',
      new TableIndex({ name: 'IDX_ORGANIZATIONS_CODE', columnNames: ['code'], isUnique: true }),
    );

    // 2. Add organization_id to users
    await queryRunner.addColumn(
      'users',
      new TableColumn({ name: 'organization_id', type: 'uuid', isNullable: true }),
    );

    await queryRunner.createForeignKey(
      'users',
      new TableForeignKey({
        columnNames: ['organization_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'organizations',
        onDelete: 'SET NULL',
      }),
    );

    await queryRunner.createIndex(
      'users',
      new TableIndex({ name: 'IDX_USERS_ORGANIZATION', columnNames: ['organization_id'] }),
    );

    // 3. Add organization_id to clients
    await queryRunner.addColumn(
      'clients',
      new TableColumn({ name: 'organization_id', type: 'uuid', isNullable: true }),
    );

    await queryRunner.createForeignKey(
      'clients',
      new TableForeignKey({
        columnNames: ['organization_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'organizations',
        onDelete: 'SET NULL',
      }),
    );

    await queryRunner.createIndex(
      'clients',
      new TableIndex({ name: 'IDX_CLIENTS_ORGANIZATION', columnNames: ['organization_id'] }),
    );

    // 4. Add organization_id to branches
    await queryRunner.addColumn(
      'branches',
      new TableColumn({ name: 'organization_id', type: 'uuid', isNullable: true }),
    );

    await queryRunner.createForeignKey(
      'branches',
      new TableForeignKey({
        columnNames: ['organization_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'organizations',
        onDelete: 'SET NULL',
      }),
    );

    await queryRunner.createIndex(
      'branches',
      new TableIndex({ name: 'IDX_BRANCHES_ORGANIZATION', columnNames: ['organization_id'] }),
    );

    // 5. Add organization_id to projects
    await queryRunner.addColumn(
      'projects',
      new TableColumn({ name: 'organization_id', type: 'uuid', isNullable: true }),
    );

    await queryRunner.createForeignKey(
      'projects',
      new TableForeignKey({
        columnNames: ['organization_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'organizations',
        onDelete: 'SET NULL',
      }),
    );

    await queryRunner.createIndex(
      'projects',
      new TableIndex({ name: 'IDX_PROJECTS_ORGANIZATION', columnNames: ['organization_id'] }),
    );

    // 6. Add organization_id and enterprise fields to assayers
    await queryRunner.addColumns('assayers', [
      new TableColumn({ name: 'organization_id', type: 'uuid', isNullable: true }),
      new TableColumn({ name: 'employee_id', type: 'varchar', length: '100', isNullable: true }),
      new TableColumn({ name: 'employee_code', type: 'varchar', length: '100', isNullable: true }),
      new TableColumn({ name: 'manager_id', type: 'uuid', isNullable: true }),
      new TableColumn({ name: 'department', type: 'varchar', length: '100', isNullable: true }),
      new TableColumn({ name: 'region', type: 'varchar', length: '100', isNullable: true }),
      new TableColumn({ name: 'joining_date', type: 'timestamptz', isNullable: true }),
      new TableColumn({ name: 'exit_date', type: 'timestamptz', isNullable: true }),
      new TableColumn({ name: 'termination_date', type: 'timestamptz', isNullable: true }),
      new TableColumn({ name: 'lifecycle_status', type: 'varchar', length: '50', default: "'INVITED'" }),
      new TableColumn({ name: 'emergency_contact_name', type: 'varchar', length: '150', isNullable: true }),
      new TableColumn({ name: 'emergency_contact_phone', type: 'varchar', length: '20', isNullable: true }),
      new TableColumn({ name: 'emergency_contact_relation', type: 'varchar', length: '50', isNullable: true }),
      new TableColumn({ name: 'photograph', type: 'text', isNullable: true }),
    ]);

    await queryRunner.createForeignKey(
      'assayers',
      new TableForeignKey({
        columnNames: ['organization_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'organizations',
        onDelete: 'SET NULL',
      }),
    );

    await queryRunner.createForeignKey(
      'assayers',
      new TableForeignKey({
        columnNames: ['manager_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'assayers',
        onDelete: 'SET NULL',
      }),
    );

    await queryRunner.createIndex(
      'assayers',
      new TableIndex({ name: 'IDX_ASSAYERS_ORGANIZATION', columnNames: ['organization_id'] }),
    );

    await queryRunner.createIndex(
      'assayers',
      new TableIndex({ name: 'IDX_ASSAYERS_MANAGER', columnNames: ['manager_id'] }),
    );

    // 7. Create assayer_government_documents table
    await queryRunner.createTable(
      new Table({
        name: 'assayer_government_documents',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'uuid_generate_v4()' },
          { name: 'created_by', type: 'varchar', isNullable: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_by', type: 'varchar', isNullable: true },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
          { name: 'version', type: 'int', default: 1 },
          { name: 'is_active', type: 'boolean', default: true },
          { name: 'assayer_id', type: 'uuid', isNullable: false },
          { name: 'document_type', type: 'varchar', length: '100', isNullable: false },
          { name: 'document_number', type: 'varchar', length: '100', isNullable: false },
          { name: 'expiry_date', type: 'timestamptz', isNullable: true },
          { name: 'verification_status', type: 'varchar', length: '50', default: "'PENDING'" },
          { name: 'verified_by', type: 'varchar', length: '150', isNullable: true },
          { name: 'verified_at', type: 'timestamptz', isNullable: true },
          { name: 'file_paths', type: 'jsonb', default: "'[]'" },
          { name: 'remarks', type: 'text', isNullable: true },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'assayer_government_documents',
      new TableForeignKey({
        columnNames: ['assayer_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'assayers',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'assayer_government_documents',
      new TableIndex({ name: 'IDX_GOV_DOC_ASSAYER', columnNames: ['assayer_id'] }),
    );

    await queryRunner.createIndex(
      'assayer_government_documents',
      new TableIndex({ name: 'IDX_GOV_DOC_TYPE_STATUS', columnNames: ['document_type', 'verification_status'] }),
    );

    // 8. Create assayer_documents table (versioned)
    await queryRunner.createTable(
      new Table({
        name: 'assayer_documents',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'uuid_generate_v4()' },
          { name: 'created_by', type: 'varchar', isNullable: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_by', type: 'varchar', isNullable: true },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
          { name: 'version', type: 'int', default: 1 },
          { name: 'is_active', type: 'boolean', default: true },
          { name: 'assayer_id', type: 'uuid', isNullable: false },
          { name: 'document_type', type: 'varchar', length: '100', isNullable: false },
          { name: 'file_name', type: 'varchar', length: '255', isNullable: false },
          { name: 'file_path', type: 'text', isNullable: false },
          { name: 'file_size', type: 'int', isNullable: false },
          { name: 'mime_type', type: 'varchar', length: '100', isNullable: true },
          { name: 'doc_version', type: 'int', default: 1 },
          { name: 'parent_document_id', type: 'uuid', isNullable: true },
          { name: 'remarks', type: 'text', isNullable: true },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'assayer_documents',
      new TableForeignKey({
        columnNames: ['assayer_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'assayers',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createForeignKey(
      'assayer_documents',
      new TableForeignKey({
        columnNames: ['parent_document_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'assayer_documents',
        onDelete: 'SET NULL',
      }),
    );

    await queryRunner.createIndex(
      'assayer_documents',
      new TableIndex({ name: 'IDX_ASSAYER_DOCS_ASSAYER', columnNames: ['assayer_id'] }),
    );

    // 9. Create assayer_remarks table
    await queryRunner.createTable(
      new Table({
        name: 'assayer_remarks',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'uuid_generate_v4()' },
          { name: 'created_by', type: 'varchar', isNullable: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_by', type: 'varchar', isNullable: true },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
          { name: 'version', type: 'int', default: 1 },
          { name: 'is_active', type: 'boolean', default: true },
          { name: 'assayer_id', type: 'uuid', isNullable: false },
          { name: 'author_id', type: 'varchar', length: '150', isNullable: false },
          { name: 'author_name', type: 'varchar', length: '200', isNullable: true },
          { name: 'content', type: 'text', isNullable: false },
          { name: 'category', type: 'varchar', length: '100', isNullable: false },
          { name: 'visibility', type: 'varchar', length: '50', default: "'INTERNAL'" },
          { name: 'attachment_paths', type: 'jsonb', default: "'[]'" },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'assayer_remarks',
      new TableForeignKey({
        columnNames: ['assayer_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'assayers',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'assayer_remarks',
      new TableIndex({ name: 'IDX_ASSAYER_REMARKS_ASSAYER', columnNames: ['assayer_id'] }),
    );

    await queryRunner.createIndex(
      'assayer_remarks',
      new TableIndex({ name: 'IDX_ASSAYER_REMARKS_CATEGORY', columnNames: ['assayer_id', 'category'] }),
    );

    // 10. Create assayer_activities table (timeline)
    await queryRunner.createTable(
      new Table({
        name: 'assayer_activities',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'uuid_generate_v4()' },
          { name: 'created_by', type: 'varchar', isNullable: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
          { name: 'updated_by', type: 'varchar', isNullable: true },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
          { name: 'version', type: 'int', default: 1 },
          { name: 'is_active', type: 'boolean', default: true },
          { name: 'assayer_id', type: 'uuid', isNullable: false },
          { name: 'event_type', type: 'varchar', length: '100', isNullable: false },
          { name: 'previous_state', type: 'varchar', length: '50', isNullable: true },
          { name: 'new_state', type: 'varchar', length: '50', isNullable: true },
          { name: 'performed_by', type: 'varchar', length: '150', isNullable: false },
          { name: 'performed_by_name', type: 'varchar', length: '200', isNullable: true },
          { name: 'occurred_at', type: 'timestamptz', default: 'now()' },
          { name: 'remarks', type: 'text', isNullable: true },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'assayer_activities',
      new TableForeignKey({
        columnNames: ['assayer_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'assayers',
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'assayer_activities',
      new TableIndex({ name: 'IDX_ASSAYER_ACTIVITIES_ASSAYER', columnNames: ['assayer_id'] }),
    );

    await queryRunner.createIndex(
      'assayer_activities',
      new TableIndex({ name: 'IDX_ASSAYER_ACTIVITIES_OCCURRED', columnNames: ['assayer_id', 'occurred_at'] }),
    );

    // Add metadata column (jsonb) after remarks
    await queryRunner.query(`ALTER TABLE "assayer_activities" ADD COLUMN "metadata" jsonb NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayer_activities" DROP COLUMN IF EXISTS "metadata"`);
    await queryRunner.dropTable('assayer_activities');
    await queryRunner.dropTable('assayer_remarks');
    await queryRunner.dropTable('assayer_documents');
    await queryRunner.dropTable('assayer_government_documents');

    await queryRunner.dropColumns('assayers', [
      'photograph', 'emergency_contact_relation', 'emergency_contact_phone',
      'emergency_contact_name', 'lifecycle_status', 'termination_date', 'exit_date',
      'joining_date', 'region', 'department', 'manager_id', 'employee_code',
      'employee_id', 'organization_id',
    ]);

    await queryRunner.dropColumns('projects', ['organization_id']);
    await queryRunner.dropColumns('branches', ['organization_id']);
    await queryRunner.dropColumns('clients', ['organization_id']);
    await queryRunner.dropColumns('users', ['organization_id']);

    await queryRunner.dropTable('organizations');
  }
}

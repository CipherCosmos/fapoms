"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddOrganizationsAndAssayerEnterprise1784654800000 = void 0;
const typeorm_1 = require("typeorm");
class AddOrganizationsAndAssayerEnterprise1784654800000 {
    async up(queryRunner) {
        const tablesWithOrg = ['users', 'clients', 'branches', 'projects', 'assayers'];
        for (const table of tablesWithOrg) {
            await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "organization_id"`);
        }
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "department_id"`);
        const assayerCols = ['employee_id', 'employee_code', 'manager_id', 'department', 'region',
            'joining_date', 'exit_date', 'termination_date', 'lifecycle_status',
            'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation', 'photograph'];
        for (const col of assayerCols) {
            await queryRunner.query(`ALTER TABLE "assayers" DROP COLUMN IF EXISTS "${col}"`);
        }
        await queryRunner.createTable(new typeorm_1.Table({
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
        }), true);
        await queryRunner.createIndex('organizations', new typeorm_1.TableIndex({ name: 'IDX_ORGANIZATIONS_CODE', columnNames: ['code'], isUnique: true }));
        await queryRunner.addColumn('users', new typeorm_1.TableColumn({ name: 'organization_id', type: 'uuid', isNullable: true }));
        await queryRunner.createForeignKey('users', new typeorm_1.TableForeignKey({
            columnNames: ['organization_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'organizations',
            onDelete: 'SET NULL',
        }));
        await queryRunner.createIndex('users', new typeorm_1.TableIndex({ name: 'IDX_USERS_ORGANIZATION', columnNames: ['organization_id'] }));
        await queryRunner.addColumn('clients', new typeorm_1.TableColumn({ name: 'organization_id', type: 'uuid', isNullable: true }));
        await queryRunner.createForeignKey('clients', new typeorm_1.TableForeignKey({
            columnNames: ['organization_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'organizations',
            onDelete: 'SET NULL',
        }));
        await queryRunner.createIndex('clients', new typeorm_1.TableIndex({ name: 'IDX_CLIENTS_ORGANIZATION', columnNames: ['organization_id'] }));
        await queryRunner.addColumn('branches', new typeorm_1.TableColumn({ name: 'organization_id', type: 'uuid', isNullable: true }));
        await queryRunner.createForeignKey('branches', new typeorm_1.TableForeignKey({
            columnNames: ['organization_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'organizations',
            onDelete: 'SET NULL',
        }));
        await queryRunner.createIndex('branches', new typeorm_1.TableIndex({ name: 'IDX_BRANCHES_ORGANIZATION', columnNames: ['organization_id'] }));
        await queryRunner.addColumn('projects', new typeorm_1.TableColumn({ name: 'organization_id', type: 'uuid', isNullable: true }));
        await queryRunner.createForeignKey('projects', new typeorm_1.TableForeignKey({
            columnNames: ['organization_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'organizations',
            onDelete: 'SET NULL',
        }));
        await queryRunner.createIndex('projects', new typeorm_1.TableIndex({ name: 'IDX_PROJECTS_ORGANIZATION', columnNames: ['organization_id'] }));
        await queryRunner.addColumns('assayers', [
            new typeorm_1.TableColumn({ name: 'organization_id', type: 'uuid', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'employee_id', type: 'varchar', length: '100', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'employee_code', type: 'varchar', length: '100', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'manager_id', type: 'uuid', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'department', type: 'varchar', length: '100', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'region', type: 'varchar', length: '100', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'joining_date', type: 'timestamptz', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'exit_date', type: 'timestamptz', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'termination_date', type: 'timestamptz', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'lifecycle_status', type: 'varchar', length: '50', default: "'INVITED'" }),
            new typeorm_1.TableColumn({ name: 'emergency_contact_name', type: 'varchar', length: '150', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'emergency_contact_phone', type: 'varchar', length: '20', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'emergency_contact_relation', type: 'varchar', length: '50', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'photograph', type: 'text', isNullable: true }),
        ]);
        await queryRunner.createForeignKey('assayers', new typeorm_1.TableForeignKey({
            columnNames: ['organization_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'organizations',
            onDelete: 'SET NULL',
        }));
        await queryRunner.createForeignKey('assayers', new typeorm_1.TableForeignKey({
            columnNames: ['manager_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'assayers',
            onDelete: 'SET NULL',
        }));
        await queryRunner.createIndex('assayers', new typeorm_1.TableIndex({ name: 'IDX_ASSAYERS_ORGANIZATION', columnNames: ['organization_id'] }));
        await queryRunner.createIndex('assayers', new typeorm_1.TableIndex({ name: 'IDX_ASSAYERS_MANAGER', columnNames: ['manager_id'] }));
        await queryRunner.createTable(new typeorm_1.Table({
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
        }), true);
        await queryRunner.createForeignKey('assayer_government_documents', new typeorm_1.TableForeignKey({
            columnNames: ['assayer_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'assayers',
            onDelete: 'CASCADE',
        }));
        await queryRunner.createIndex('assayer_government_documents', new typeorm_1.TableIndex({ name: 'IDX_GOV_DOC_ASSAYER', columnNames: ['assayer_id'] }));
        await queryRunner.createIndex('assayer_government_documents', new typeorm_1.TableIndex({ name: 'IDX_GOV_DOC_TYPE_STATUS', columnNames: ['document_type', 'verification_status'] }));
        await queryRunner.createTable(new typeorm_1.Table({
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
        }), true);
        await queryRunner.createForeignKey('assayer_documents', new typeorm_1.TableForeignKey({
            columnNames: ['assayer_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'assayers',
            onDelete: 'CASCADE',
        }));
        await queryRunner.createForeignKey('assayer_documents', new typeorm_1.TableForeignKey({
            columnNames: ['parent_document_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'assayer_documents',
            onDelete: 'SET NULL',
        }));
        await queryRunner.createIndex('assayer_documents', new typeorm_1.TableIndex({ name: 'IDX_ASSAYER_DOCS_ASSAYER', columnNames: ['assayer_id'] }));
        await queryRunner.createTable(new typeorm_1.Table({
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
        }), true);
        await queryRunner.createForeignKey('assayer_remarks', new typeorm_1.TableForeignKey({
            columnNames: ['assayer_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'assayers',
            onDelete: 'CASCADE',
        }));
        await queryRunner.createIndex('assayer_remarks', new typeorm_1.TableIndex({ name: 'IDX_ASSAYER_REMARKS_ASSAYER', columnNames: ['assayer_id'] }));
        await queryRunner.createIndex('assayer_remarks', new typeorm_1.TableIndex({ name: 'IDX_ASSAYER_REMARKS_CATEGORY', columnNames: ['assayer_id', 'category'] }));
        await queryRunner.createTable(new typeorm_1.Table({
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
        }), true);
        await queryRunner.createForeignKey('assayer_activities', new typeorm_1.TableForeignKey({
            columnNames: ['assayer_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'assayers',
            onDelete: 'CASCADE',
        }));
        await queryRunner.createIndex('assayer_activities', new typeorm_1.TableIndex({ name: 'IDX_ASSAYER_ACTIVITIES_ASSAYER', columnNames: ['assayer_id'] }));
        await queryRunner.createIndex('assayer_activities', new typeorm_1.TableIndex({ name: 'IDX_ASSAYER_ACTIVITIES_OCCURRED', columnNames: ['assayer_id', 'occurred_at'] }));
        await queryRunner.query(`ALTER TABLE "assayer_activities" ADD COLUMN "metadata" jsonb NULL`);
    }
    async down(queryRunner) {
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
exports.AddOrganizationsAndAssayerEnterprise1784654800000 = AddOrganizationsAndAssayerEnterprise1784654800000;
//# sourceMappingURL=1784654800000-AddOrganizationsAndAssayerEnterprise.js.map
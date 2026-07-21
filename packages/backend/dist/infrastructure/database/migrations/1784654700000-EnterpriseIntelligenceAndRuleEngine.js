"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnterpriseIntelligenceAndRuleEngine1784654700000 = void 0;
const typeorm_1 = require("typeorm");
class EnterpriseIntelligenceAndRuleEngine1784654700000 {
    async up(queryRunner) {
        await queryRunner.createTable(new typeorm_1.Table({
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
                { name: 'type', type: 'varchar', length: '50' },
                { name: 'name', type: 'varchar', length: '150' },
                { name: 'level', type: 'varchar', length: '50', isNullable: true },
                { name: 'expiry_date', type: 'timestamptz', isNullable: true },
                { name: 'metadata', type: 'jsonb', isNullable: true },
            ],
        }), true);
        await queryRunner.createForeignKey('workforce_attributes', new typeorm_1.TableForeignKey({
            columnNames: ['assayer_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'assayers',
            onDelete: 'CASCADE',
        }));
        await queryRunner.createIndex('workforce_attributes', new typeorm_1.TableIndex({
            name: 'IDX_WORKFORCE_ATTRIBUTES_ASSAYER',
            columnNames: ['assayer_id'],
        }));
        await queryRunner.createTable(new typeorm_1.Table({
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
                { name: 'scope', type: 'varchar', length: '50' },
                { name: 'target_id', type: 'uuid', isNullable: true },
                { name: 'rule_type', type: 'varchar', length: '100' },
                { name: 'conditions', type: 'jsonb' },
                { name: 'actions', type: 'jsonb', isNullable: true },
            ],
        }), true);
        await queryRunner.createIndex('business_rules', new typeorm_1.TableIndex({
            name: 'IDX_BUSINESS_RULES_SCOPE',
            columnNames: ['scope', 'target_id'],
        }));
        await queryRunner.addColumns('clients', [
            new typeorm_1.TableColumn({ name: 'priority', type: 'varchar', length: '50', default: "'MEDIUM'" }),
            new typeorm_1.TableColumn({ name: 'budget', type: 'decimal', precision: 12, scale: 2, isNullable: true }),
            new typeorm_1.TableColumn({ name: 'preferred_assayers', type: 'jsonb', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'restricted_assayers', type: 'jsonb', isNullable: true }),
            new typeorm_1.TableColumn({ name: 'planning_preferences', type: 'jsonb', isNullable: true }),
        ]);
        await queryRunner.addColumns('branches', [
            new typeorm_1.TableColumn({ name: 'risk_score', type: 'decimal', precision: 5, scale: 2, default: 0.00 }),
            new typeorm_1.TableColumn({ name: 'complexity', type: 'varchar', length: '50', default: "'STANDARD'" }),
            new typeorm_1.TableColumn({ name: 'estimated_duration_hours', type: 'decimal', precision: 5, scale: 2, default: 8.00 }),
            new typeorm_1.TableColumn({ name: 'required_competencies', type: 'jsonb', isNullable: true }),
        ]);
    }
    async down(queryRunner) {
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
exports.EnterpriseIntelligenceAndRuleEngine1784654700000 = EnterpriseIntelligenceAndRuleEngine1784654700000;
//# sourceMappingURL=1784654700000-EnterpriseIntelligenceAndRuleEngine.js.map
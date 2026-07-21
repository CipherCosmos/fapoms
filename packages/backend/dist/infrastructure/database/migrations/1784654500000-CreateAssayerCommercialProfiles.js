"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateAssayerCommercialProfiles1784654500000 = void 0;
const typeorm_1 = require("typeorm");
class CreateAssayerCommercialProfiles1784654500000 {
    async up(queryRunner) {
        await queryRunner.createTable(new typeorm_1.Table({
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
        }), true);
        await queryRunner.createForeignKey('assayer_commercial_profiles', new typeorm_1.TableForeignKey({
            columnNames: ['assayer_id'],
            referencedColumnNames: ['id'],
            referencedTableName: 'assayers',
            onDelete: 'CASCADE',
        }));
        await queryRunner.createIndex('assayer_commercial_profiles', new typeorm_1.TableIndex({
            name: 'IDX_COMMERCIAL_PROFILE_ASSAYER',
            columnNames: ['assayer_id'],
        }));
        await queryRunner.createIndex('assayer_commercial_profiles', new typeorm_1.TableIndex({
            name: 'IDX_COMMERCIAL_PROFILE_EFFECTIVE',
            columnNames: ['effective_start_date', 'effective_end_date'],
        }));
    }
    async down(queryRunner) {
        await queryRunner.dropTable('assayer_commercial_profiles');
    }
}
exports.CreateAssayerCommercialProfiles1784654500000 = CreateAssayerCommercialProfiles1784654500000;
//# sourceMappingURL=1784654500000-CreateAssayerCommercialProfiles.js.map
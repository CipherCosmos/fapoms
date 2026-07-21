"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddWorkforceIntelligenceToAssayers1784654600000 = void 0;
const typeorm_1 = require("typeorm");
class AddWorkforceIntelligenceToAssayers1784654600000 {
    async up(queryRunner) {
        await queryRunner.addColumns('assayers', [
            new typeorm_1.TableColumn({
                name: 'employment_type',
                type: 'varchar',
                length: '50',
                default: "'INTERNAL'",
            }),
            new typeorm_1.TableColumn({
                name: 'skills',
                type: 'jsonb',
                isNullable: true,
            }),
            new typeorm_1.TableColumn({
                name: 'certifications',
                type: 'jsonb',
                isNullable: true,
            }),
            new typeorm_1.TableColumn({
                name: 'languages',
                type: 'jsonb',
                isNullable: true,
            }),
            new typeorm_1.TableColumn({
                name: 'preferred_regions',
                type: 'jsonb',
                isNullable: true,
            }),
            new typeorm_1.TableColumn({
                name: 'specializations',
                type: 'jsonb',
                isNullable: true,
            }),
            new typeorm_1.TableColumn({
                name: 'experience_years',
                type: 'int',
                default: 0,
            }),
            new typeorm_1.TableColumn({
                name: 'performance_rating',
                type: 'decimal',
                precision: 3,
                scale: 2,
                default: 5.00,
            }),
            new typeorm_1.TableColumn({
                name: 'leaves',
                type: 'jsonb',
                isNullable: true,
            }),
            new typeorm_1.TableColumn({
                name: 'working_hours',
                type: 'jsonb',
                isNullable: true,
            }),
            new typeorm_1.TableColumn({
                name: 'max_daily_workload',
                type: 'int',
                default: 3,
            }),
            new typeorm_1.TableColumn({
                name: 'max_weekly_workload',
                type: 'int',
                default: 15,
            }),
        ]);
    }
    async down(queryRunner) {
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
exports.AddWorkforceIntelligenceToAssayers1784654600000 = AddWorkforceIntelligenceToAssayers1784654600000;
//# sourceMappingURL=1784654600000-AddWorkforceIntelligenceToAssayers.js.map
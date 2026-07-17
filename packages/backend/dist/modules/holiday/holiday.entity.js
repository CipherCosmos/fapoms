"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HolidayEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
let HolidayEntity = class HolidayEntity extends base_entity_1.BaseEntity {
    name;
    date;
    type;
    applicableStates;
    year;
};
exports.HolidayEntity = HolidayEntity;
__decorate([
    (0, typeorm_1.Column)({ length: 150 }),
    __metadata("design:type", String)
], HolidayEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'date' }),
    __metadata("design:type", Date)
], HolidayEntity.prototype, "date", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'varchar',
        length: 20,
        default: 'NATIONAL',
        comment: 'Holiday type: NATIONAL, BANK, REGIONAL, CUSTOM',
    }),
    __metadata("design:type", String)
], HolidayEntity.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'applicable_states',
        type: 'jsonb',
        nullable: true,
        comment: 'List of state codes where this holiday is observed. Empty = nationwide.',
    }),
    __metadata("design:type", Object)
], HolidayEntity.prototype, "applicableStates", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int' }),
    __metadata("design:type", Number)
], HolidayEntity.prototype, "year", void 0);
exports.HolidayEntity = HolidayEntity = __decorate([
    (0, typeorm_1.Entity)('holidays'),
    (0, typeorm_1.Index)(['date']),
    (0, typeorm_1.Index)(['year'])
], HolidayEntity);
//# sourceMappingURL=holiday.entity.js.map
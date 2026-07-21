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
exports.AssayerCommercialProfileEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const assayer_entity_1 = require("./assayer.entity");
let AssayerCommercialProfileEntity = class AssayerCommercialProfileEntity extends base_entity_1.BaseEntity {
    assayerId;
    assayer;
    baseFee;
    hourlyRate;
    dailyRate;
    travelReimbursement;
    accommodationAllowance;
    mealAllowance;
    currency;
    effectiveStartDate;
    effectiveEndDate;
};
exports.AssayerCommercialProfileEntity = AssayerCommercialProfileEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'assayer_id', type: 'uuid' }),
    __metadata("design:type", String)
], AssayerCommercialProfileEntity.prototype, "assayerId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => assayer_entity_1.AssayerEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'assayer_id' }),
    __metadata("design:type", assayer_entity_1.AssayerEntity)
], AssayerCommercialProfileEntity.prototype, "assayer", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'base_fee', type: 'decimal', precision: 12, scale: 2, default: 0 }),
    __metadata("design:type", Number)
], AssayerCommercialProfileEntity.prototype, "baseFee", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'hourly_rate', type: 'decimal', precision: 12, scale: 2, default: 0 }),
    __metadata("design:type", Number)
], AssayerCommercialProfileEntity.prototype, "hourlyRate", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'daily_rate', type: 'decimal', precision: 12, scale: 2, default: 0 }),
    __metadata("design:type", Number)
], AssayerCommercialProfileEntity.prototype, "dailyRate", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'travel_reimbursement', type: 'decimal', precision: 12, scale: 2, default: 0 }),
    __metadata("design:type", Number)
], AssayerCommercialProfileEntity.prototype, "travelReimbursement", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'accommodation_allowance', type: 'decimal', precision: 12, scale: 2, default: 0 }),
    __metadata("design:type", Number)
], AssayerCommercialProfileEntity.prototype, "accommodationAllowance", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'meal_allowance', type: 'decimal', precision: 12, scale: 2, default: 0 }),
    __metadata("design:type", Number)
], AssayerCommercialProfileEntity.prototype, "mealAllowance", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 10, default: 'INR' }),
    __metadata("design:type", String)
], AssayerCommercialProfileEntity.prototype, "currency", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'effective_start_date', type: 'timestamptz' }),
    __metadata("design:type", Date)
], AssayerCommercialProfileEntity.prototype, "effectiveStartDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'effective_end_date', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], AssayerCommercialProfileEntity.prototype, "effectiveEndDate", void 0);
exports.AssayerCommercialProfileEntity = AssayerCommercialProfileEntity = __decorate([
    (0, typeorm_1.Entity)('assayer_commercial_profiles'),
    (0, typeorm_1.Index)(['assayerId']),
    (0, typeorm_1.Index)(['effectiveStartDate', 'effectiveEndDate'])
], AssayerCommercialProfileEntity);
//# sourceMappingURL=assayer-commercial-profile.entity.js.map
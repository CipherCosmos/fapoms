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
exports.AssayerEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const shared_1 = require("@fapoms/shared");
let AssayerEntity = class AssayerEntity extends base_entity_1.BaseEntity {
    assayerCode;
    firstName;
    lastName;
    displayName;
    email;
    phone;
    alternatePhone;
    address;
    state;
    district;
    city;
    pincode;
    latitude;
    longitude;
    location;
    status;
    panNumber;
    bankAccountNumber;
    ifscCode;
    notes;
};
exports.AssayerEntity = AssayerEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'assayer_code', unique: true, length: 50 }),
    __metadata("design:type", String)
], AssayerEntity.prototype, "assayerCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'first_name', length: 100 }),
    __metadata("design:type", String)
], AssayerEntity.prototype, "firstName", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'last_name', length: 100 }),
    __metadata("design:type", String)
], AssayerEntity.prototype, "lastName", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'display_name', length: 200 }),
    __metadata("design:type", String)
], AssayerEntity.prototype, "displayName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 255, nullable: true }),
    __metadata("design:type", Object)
], AssayerEntity.prototype, "email", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 20 }),
    __metadata("design:type", String)
], AssayerEntity.prototype, "phone", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'alternate_phone', type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], AssayerEntity.prototype, "alternatePhone", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], AssayerEntity.prototype, "address", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 100 }),
    __metadata("design:type", String)
], AssayerEntity.prototype, "state", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 100 }),
    __metadata("design:type", String)
], AssayerEntity.prototype, "district", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 100 }),
    __metadata("design:type", String)
], AssayerEntity.prototype, "city", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], AssayerEntity.prototype, "pincode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'decimal', precision: 10, scale: 7, nullable: true }),
    __metadata("design:type", Object)
], AssayerEntity.prototype, "latitude", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'decimal', precision: 10, scale: 7, nullable: true }),
    __metadata("design:type", Object)
], AssayerEntity.prototype, "longitude", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'geometry',
        spatialFeatureType: 'Point',
        srid: 4326,
        nullable: true,
    }),
    (0, typeorm_1.Index)({ spatial: true }),
    __metadata("design:type", Object)
], AssayerEntity.prototype, "location", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'varchar',
        length: 50,
        default: shared_1.AssayerStatus.REGISTERED,
        comment: 'Assayer status: REGISTERED, ACTIVE, INACTIVE, BUSY, SUSPENDED',
    }),
    __metadata("design:type", String)
], AssayerEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'pan_number', type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], AssayerEntity.prototype, "panNumber", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'bank_account_number', type: 'varchar', length: 50, nullable: true }),
    __metadata("design:type", Object)
], AssayerEntity.prototype, "bankAccountNumber", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'ifsc_code', type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], AssayerEntity.prototype, "ifscCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], AssayerEntity.prototype, "notes", void 0);
exports.AssayerEntity = AssayerEntity = __decorate([
    (0, typeorm_1.Entity)('assayers'),
    (0, typeorm_1.Index)(['assayerCode']),
    (0, typeorm_1.Index)(['status']),
    (0, typeorm_1.Index)(['state'])
], AssayerEntity);
//# sourceMappingURL=assayer.entity.js.map
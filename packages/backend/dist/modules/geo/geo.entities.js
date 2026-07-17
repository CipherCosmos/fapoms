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
exports.GeoCityEntity = exports.GeoDistrictEntity = exports.GeoStateEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
let GeoStateEntity = class GeoStateEntity extends base_entity_1.BaseEntity {
    name;
    code;
};
exports.GeoStateEntity = GeoStateEntity;
__decorate([
    (0, typeorm_1.Column)({ unique: true, length: 100 }),
    __metadata("design:type", String)
], GeoStateEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ unique: true, length: 10 }),
    __metadata("design:type", String)
], GeoStateEntity.prototype, "code", void 0);
exports.GeoStateEntity = GeoStateEntity = __decorate([
    (0, typeorm_1.Entity)('geo_states')
], GeoStateEntity);
let GeoDistrictEntity = class GeoDistrictEntity extends base_entity_1.BaseEntity {
    name;
    stateId;
    state;
};
exports.GeoDistrictEntity = GeoDistrictEntity;
__decorate([
    (0, typeorm_1.Column)({ length: 100 }),
    __metadata("design:type", String)
], GeoDistrictEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'state_id', type: 'uuid' }),
    __metadata("design:type", String)
], GeoDistrictEntity.prototype, "stateId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => GeoStateEntity),
    (0, typeorm_1.JoinColumn)({ name: 'state_id' }),
    __metadata("design:type", GeoStateEntity)
], GeoDistrictEntity.prototype, "state", void 0);
exports.GeoDistrictEntity = GeoDistrictEntity = __decorate([
    (0, typeorm_1.Entity)('geo_districts'),
    (0, typeorm_1.Index)(['stateId'])
], GeoDistrictEntity);
let GeoCityEntity = class GeoCityEntity extends base_entity_1.BaseEntity {
    name;
    districtId;
    pincode;
    district;
};
exports.GeoCityEntity = GeoCityEntity;
__decorate([
    (0, typeorm_1.Column)({ length: 100 }),
    __metadata("design:type", String)
], GeoCityEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'district_id', type: 'uuid' }),
    __metadata("design:type", String)
], GeoCityEntity.prototype, "districtId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 10, nullable: true }),
    __metadata("design:type", Object)
], GeoCityEntity.prototype, "pincode", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => GeoDistrictEntity),
    (0, typeorm_1.JoinColumn)({ name: 'district_id' }),
    __metadata("design:type", GeoDistrictEntity)
], GeoCityEntity.prototype, "district", void 0);
exports.GeoCityEntity = GeoCityEntity = __decorate([
    (0, typeorm_1.Entity)('geo_cities'),
    (0, typeorm_1.Index)(['districtId'])
], GeoCityEntity);
//# sourceMappingURL=geo.entities.js.map
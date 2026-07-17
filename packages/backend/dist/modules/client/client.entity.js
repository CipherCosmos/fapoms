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
exports.ClientEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
let ClientEntity = class ClientEntity extends base_entity_1.BaseEntity {
    clientCode;
    name;
    displayName;
    contactPerson;
    contactEmail;
    contactPhone;
    address;
    configuration;
};
exports.ClientEntity = ClientEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'client_code', unique: true, length: 50 }),
    __metadata("design:type", String)
], ClientEntity.prototype, "clientCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 255 }),
    __metadata("design:type", String)
], ClientEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'display_name', length: 255 }),
    __metadata("design:type", String)
], ClientEntity.prototype, "displayName", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'contact_person', type: 'varchar', length: 200, nullable: true }),
    __metadata("design:type", Object)
], ClientEntity.prototype, "contactPerson", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'contact_email', type: 'varchar', length: 255, nullable: true }),
    __metadata("design:type", Object)
], ClientEntity.prototype, "contactEmail", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'contact_phone', type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], ClientEntity.prototype, "contactPhone", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], ClientEntity.prototype, "address", void 0);
__decorate([
    (0, typeorm_1.OneToOne)('ClientConfigurationEntity', 'client', { cascade: true, eager: true }),
    __metadata("design:type", Object)
], ClientEntity.prototype, "configuration", void 0);
exports.ClientEntity = ClientEntity = __decorate([
    (0, typeorm_1.Entity)('clients')
], ClientEntity);
//# sourceMappingURL=client.entity.js.map
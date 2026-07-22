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
exports.ClientContractEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
let ClientContractEntity = class ClientContractEntity extends base_entity_1.BaseEntity {
    clientId;
    client;
    contractNumber;
    title;
    description;
    signedDate;
    effectiveFrom;
    effectiveTo;
    value;
    currency;
    status;
    terms;
    documentUrl;
};
exports.ClientContractEntity = ClientContractEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'client_id', type: 'uuid' }),
    __metadata("design:type", String)
], ClientContractEntity.prototype, "clientId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)('ClientEntity', 'contracts', { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'client_id' }),
    __metadata("design:type", Function)
], ClientContractEntity.prototype, "client", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'contract_number', unique: true, length: 50 }),
    __metadata("design:type", String)
], ClientContractEntity.prototype, "contractNumber", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 255 }),
    __metadata("design:type", String)
], ClientContractEntity.prototype, "title", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], ClientContractEntity.prototype, "description", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'signed_date', type: 'date', nullable: true }),
    __metadata("design:type", Object)
], ClientContractEntity.prototype, "signedDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'effective_from', type: 'date' }),
    __metadata("design:type", String)
], ClientContractEntity.prototype, "effectiveFrom", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'effective_to', type: 'date', nullable: true }),
    __metadata("design:type", Object)
], ClientContractEntity.prototype, "effectiveTo", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'decimal', precision: 14, scale: 2, nullable: true }),
    __metadata("design:type", Object)
], ClientContractEntity.prototype, "value", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 3, default: 'INR' }),
    __metadata("design:type", String)
], ClientContractEntity.prototype, "currency", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 50, default: 'DRAFT' }),
    __metadata("design:type", String)
], ClientContractEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], ClientContractEntity.prototype, "terms", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'document_url', type: 'varchar', length: 500, nullable: true }),
    __metadata("design:type", Object)
], ClientContractEntity.prototype, "documentUrl", void 0);
exports.ClientContractEntity = ClientContractEntity = __decorate([
    (0, typeorm_1.Entity)('client_contracts'),
    (0, typeorm_1.Index)(['clientId'])
], ClientContractEntity);
//# sourceMappingURL=client-contract.entity.js.map
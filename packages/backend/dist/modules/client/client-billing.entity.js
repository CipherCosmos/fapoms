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
exports.ClientBillingEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
let ClientBillingEntity = class ClientBillingEntity extends base_entity_1.BaseEntity {
    clientId;
    client;
    paymentTerms;
    currency;
    taxIdentifier;
    invoiceCycle;
    billingAddress;
    bankAccount;
    bankName;
    ifscCode;
    notes;
};
exports.ClientBillingEntity = ClientBillingEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'client_id', type: 'uuid', unique: true }),
    __metadata("design:type", String)
], ClientBillingEntity.prototype, "clientId", void 0);
__decorate([
    (0, typeorm_1.OneToOne)('ClientEntity', 'billing', { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'client_id' }),
    __metadata("design:type", Function)
], ClientBillingEntity.prototype, "client", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'payment_terms', length: 200 }),
    __metadata("design:type", String)
], ClientBillingEntity.prototype, "paymentTerms", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 3, default: 'INR' }),
    __metadata("design:type", String)
], ClientBillingEntity.prototype, "currency", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'tax_identifier', type: 'varchar', length: 100, nullable: true }),
    __metadata("design:type", Object)
], ClientBillingEntity.prototype, "taxIdentifier", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'invoice_cycle', length: 50 }),
    __metadata("design:type", String)
], ClientBillingEntity.prototype, "invoiceCycle", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'billing_address', type: 'text' }),
    __metadata("design:type", String)
], ClientBillingEntity.prototype, "billingAddress", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'bank_account', type: 'varchar', length: 50, nullable: true }),
    __metadata("design:type", Object)
], ClientBillingEntity.prototype, "bankAccount", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'bank_name', type: 'varchar', length: 200, nullable: true }),
    __metadata("design:type", Object)
], ClientBillingEntity.prototype, "bankName", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'ifsc_code', type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], ClientBillingEntity.prototype, "ifscCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], ClientBillingEntity.prototype, "notes", void 0);
exports.ClientBillingEntity = ClientBillingEntity = __decorate([
    (0, typeorm_1.Entity)('client_billing')
], ClientBillingEntity);
//# sourceMappingURL=client-billing.entity.js.map
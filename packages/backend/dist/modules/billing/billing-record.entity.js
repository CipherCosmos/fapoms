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
exports.BillingRecord = void 0;
const typeorm_1 = require("typeorm");
let BillingRecord = class BillingRecord {
    id;
    auditId;
    assayerId;
    baseFee;
    travelAllowance;
    penalties;
    gst;
    tds;
    netPayable;
    invoiceStatus;
    createdAt;
};
exports.BillingRecord = BillingRecord;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], BillingRecord.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], BillingRecord.prototype, "auditId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], BillingRecord.prototype, "assayerId", void 0);
__decorate([
    (0, typeorm_1.Column)('decimal'),
    __metadata("design:type", Number)
], BillingRecord.prototype, "baseFee", void 0);
__decorate([
    (0, typeorm_1.Column)('decimal', { default: 0 }),
    __metadata("design:type", Number)
], BillingRecord.prototype, "travelAllowance", void 0);
__decorate([
    (0, typeorm_1.Column)('decimal', { default: 0 }),
    __metadata("design:type", Number)
], BillingRecord.prototype, "penalties", void 0);
__decorate([
    (0, typeorm_1.Column)('decimal', { default: 0 }),
    __metadata("design:type", Number)
], BillingRecord.prototype, "gst", void 0);
__decorate([
    (0, typeorm_1.Column)('decimal', { default: 0 }),
    __metadata("design:type", Number)
], BillingRecord.prototype, "tds", void 0);
__decorate([
    (0, typeorm_1.Column)('decimal'),
    __metadata("design:type", Number)
], BillingRecord.prototype, "netPayable", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], BillingRecord.prototype, "invoiceStatus", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], BillingRecord.prototype, "createdAt", void 0);
exports.BillingRecord = BillingRecord = __decorate([
    (0, typeorm_1.Entity)('assayer_billing_records')
], BillingRecord);
//# sourceMappingURL=billing-record.entity.js.map
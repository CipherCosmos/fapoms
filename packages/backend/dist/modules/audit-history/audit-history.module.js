"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditHistoryModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const audit_history_entity_1 = require("./audit-history.entity");
const audit_evidence_entity_1 = require("./audit-evidence.entity");
const audit_history_service_1 = require("./audit-history.service");
let AuditHistoryModule = class AuditHistoryModule {
};
exports.AuditHistoryModule = AuditHistoryModule;
exports.AuditHistoryModule = AuditHistoryModule = __decorate([
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([audit_history_entity_1.AuditHistoryRecord, audit_evidence_entity_1.AuditEvidence])],
        providers: [audit_history_service_1.AuditHistoryService],
        exports: [audit_history_service_1.AuditHistoryService],
    })
], AuditHistoryModule);
//# sourceMappingURL=audit-history.module.js.map
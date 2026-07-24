"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditPlatformModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const audit_entity_1 = require("./audit.entity");
const audit_service_1 = require("./audit.service");
const billing_module_1 = require("../billing/billing.module");
const ledger_module_1 = require("../ledger/ledger.module");
const audit_history_module_1 = require("../audit-history/audit-history.module");
let AuditPlatformModule = class AuditPlatformModule {
};
exports.AuditPlatformModule = AuditPlatformModule;
exports.AuditPlatformModule = AuditPlatformModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([audit_entity_1.AuditEntity]),
            billing_module_1.BillingModule,
            ledger_module_1.LedgerModule,
            audit_history_module_1.AuditHistoryModule,
        ],
        providers: [{ provide: 'AuditPlatformService', useClass: audit_service_1.AuditService }, audit_service_1.AuditService],
        exports: ['AuditPlatformService', audit_service_1.AuditService],
    })
], AuditPlatformModule);
//# sourceMappingURL=audit.module.js.map
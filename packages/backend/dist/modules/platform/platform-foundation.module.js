"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlatformFoundationModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const bull_1 = require("@nestjs/bull");
const configuration_service_1 = require("./configuration/configuration.service");
const authorization_service_1 = require("./authz/authorization.service");
const event_dispatcher_service_1 = require("./events/event-dispatcher.service");
const workflow_engine_service_1 = require("./workflow/workflow-engine.service");
const tenant_resolver_service_1 = require("./tenant/tenant-resolver.service");
const platform_audit_service_1 = require("./audit/platform-audit.service");
const audit_log_entity_1 = require("./audit/audit-log.entity");
const observability_service_1 = require("./observability/observability.service");
const bull_queue_manager_1 = require("../../infrastructure/queue/bull-queue-manager");
let PlatformFoundationModule = class PlatformFoundationModule {
};
exports.PlatformFoundationModule = PlatformFoundationModule;
exports.PlatformFoundationModule = PlatformFoundationModule = __decorate([
    (0, common_1.Global)(),
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([
                audit_log_entity_1.AuditLogEntity,
            ]),
            bull_1.BullModule.registerQueue({
                name: 'background-jobs',
            }),
        ],
        providers: [
            { provide: 'ConfigurationManagerInterface', useClass: configuration_service_1.DefaultConfigurationService },
            { provide: 'AuthorizationService', useClass: authorization_service_1.DefaultAuthorizationService },
            { provide: 'EventDispatcherInterface', useClass: event_dispatcher_service_1.DefaultEventDispatcher },
            workflow_engine_service_1.ReusableWorkflowEngine,
            tenant_resolver_service_1.TenantContextResolver,
            platform_audit_service_1.PlatformAuditService,
            { provide: 'StructuredLogger', useClass: observability_service_1.DefaultObservabilityService },
            { provide: 'BackgroundQueueManager', useClass: bull_queue_manager_1.BullQueueManager },
        ],
        exports: [
            'ConfigurationManagerInterface',
            'AuthorizationService',
            'EventDispatcherInterface',
            workflow_engine_service_1.ReusableWorkflowEngine,
            tenant_resolver_service_1.TenantContextResolver,
            platform_audit_service_1.PlatformAuditService,
            'StructuredLogger',
            'BackgroundQueueManager',
        ],
    })
], PlatformFoundationModule);
//# sourceMappingURL=platform-foundation.module.js.map
"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("@nestjs/typeorm");
const bull_1 = require("@nestjs/bull");
const database_config_1 = require("./infrastructure/database/database.config");
const auth_module_1 = require("./modules/auth/auth.module");
const user_module_1 = require("./modules/user/user.module");
const audit_module_1 = require("./core/audit/audit.module");
const platform_module_1 = require("./modules/platform/platform.module");
const platform_foundation_module_1 = require("./modules/platform/platform-foundation.module");
const organization_module_1 = require("./modules/organization/organization.module");
const client_module_1 = require("./modules/client/client.module");
const branch_module_1 = require("./modules/branch/branch.module");
const assayer_module_1 = require("./modules/assayer/assayer.module");
const holiday_module_1 = require("./modules/holiday/holiday.module");
const zone_module_1 = require("./modules/zone/zone.module");
const planning_module_1 = require("./modules/planning/planning.module");
const project_module_1 = require("./modules/project/project.module");
const assignment_module_1 = require("./modules/assignment/assignment.module");
const scheduling_module_1 = require("./modules/scheduling/scheduling.module");
const communication_module_1 = require("./modules/communication/communication.module");
const notifications_module_1 = require("./modules/notifications/notifications.module");
const document_module_1 = require("./modules/document/document.module");
const validation_module_1 = require("./modules/validation/validation.module");
const ocr_module_1 = require("./infrastructure/ocr/ocr.module");
const geo_module_1 = require("./modules/geo/geo.module");
const search_module_1 = require("./modules/search/search.module");
const audit_history_module_1 = require("./modules/audit-history/audit-history.module");
const billing_module_1 = require("./modules/billing/billing.module");
const ledger_module_1 = require("./modules/ledger/ledger.module");
const audit_module_2 = require("./modules/audit/audit.module");
const customer_master_module_1 = require("./modules/customer-master/customer-master.module");
const validation_query_module_1 = require("./modules/validation-query/validation-query.module");
const queue_module_1 = require("./infrastructure/queue/queue.module");
const sla_scanner_module_1 = require("./infrastructure/scheduler/sla-scanner.module");
const realtime_module_1 = require("./modules/realtime/realtime.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                envFilePath: ['.env.local', '.env'],
            }),
            typeorm_1.TypeOrmModule.forRootAsync({
                imports: [config_1.ConfigModule],
                inject: [config_1.ConfigService],
                useFactory: database_config_1.databaseConfig,
            }),
            bull_1.BullModule.forRootAsync({
                imports: [config_1.ConfigModule],
                inject: [config_1.ConfigService],
                useFactory: (config) => ({
                    redis: {
                        host: config.get('REDIS_HOST', 'localhost'),
                        port: config.get('REDIS_PORT', 6379),
                        password: config.get('REDIS_PASSWORD'),
                    },
                }),
            }),
            audit_module_1.AuditModule,
            auth_module_1.AuthModule,
            user_module_1.UserModule,
            platform_module_1.PlatformModule,
            platform_foundation_module_1.PlatformFoundationModule,
            organization_module_1.OrganizationModule,
            client_module_1.ClientModule,
            branch_module_1.BranchModule,
            assayer_module_1.AssayerModule,
            holiday_module_1.HolidayModule,
            zone_module_1.ZoneModule,
            planning_module_1.PlanningModule,
            project_module_1.ProjectModule,
            assignment_module_1.AssignmentModule,
            scheduling_module_1.SchedulingModule,
            communication_module_1.CommunicationModule,
            notifications_module_1.NotificationsModule,
            document_module_1.DocumentModule,
            validation_module_1.ValidationModule,
            ocr_module_1.OcrModule,
            geo_module_1.GeoModule,
            search_module_1.SearchModule,
            audit_history_module_1.AuditHistoryModule,
            billing_module_1.BillingModule,
            ledger_module_1.LedgerModule,
            audit_module_2.AuditPlatformModule,
            customer_master_module_1.CustomerMasterModule,
            validation_query_module_1.ValidationQueryModule,
            queue_module_1.QueueModule,
            sla_scanner_module_1.SlaScannerModule,
            realtime_module_1.RealtimeModule,
        ],
        providers: [],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map
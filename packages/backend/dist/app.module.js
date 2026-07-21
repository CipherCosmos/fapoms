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
const database_config_1 = require("./infrastructure/database/database.config");
const auth_module_1 = require("./modules/auth/auth.module");
const user_module_1 = require("./modules/user/user.module");
const audit_module_1 = require("./core/audit/audit.module");
const platform_module_1 = require("./modules/platform/platform.module");
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
            audit_module_1.AuditModule,
            auth_module_1.AuthModule,
            user_module_1.UserModule,
            platform_module_1.PlatformModule,
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
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map
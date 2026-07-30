"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssignmentModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const assignment_service_1 = require("./assignment.service");
const assignment_controller_1 = require("./assignment.controller");
const assignment_entity_1 = require("./assignment.entity");
const assignment_comment_entity_1 = require("./assignment-comment.entity");
const holiday_module_1 = require("../holiday/holiday.module");
const platform_module_1 = require("../platform/platform.module");
const notifications_module_1 = require("../notifications/notifications.module");
const assayer_module_1 = require("../assayer/assayer.module");
const project_module_1 = require("../project/project.module");
const planning_module_1 = require("../planning/planning.module");
const geo_module_1 = require("../geo/geo.module");
const validation_module_1 = require("../validation/validation.module");
let AssignmentModule = class AssignmentModule {
};
exports.AssignmentModule = AssignmentModule;
exports.AssignmentModule = AssignmentModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([assignment_entity_1.AssignmentEntity, assignment_comment_entity_1.AssignmentCommentEntity]),
            holiday_module_1.HolidayModule,
            platform_module_1.PlatformModule,
            notifications_module_1.NotificationsModule,
            assayer_module_1.AssayerModule,
            project_module_1.ProjectModule,
            geo_module_1.GeoModule,
            validation_module_1.ValidationModule,
            (0, common_1.forwardRef)(() => planning_module_1.PlanningModule),
        ],
        controllers: [assignment_controller_1.AssignmentController],
        providers: [assignment_service_1.AssignmentService],
        exports: [assignment_service_1.AssignmentService],
    })
], AssignmentModule);
//# sourceMappingURL=assignment.module.js.map
"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const project_service_1 = require("./project.service");
const project_query_service_1 = require("./project-query.service");
const project_controller_1 = require("./project.controller");
const project_entity_1 = require("./project.entity");
const project_branch_entity_1 = require("./project-branch.entity");
const assessment_entity_1 = require("./assessment.entity");
const call_log_entity_1 = require("./call-log.entity");
const client_entity_1 = require("../client/client.entity");
const user_entity_1 = require("../user/user.entity");
const zone_entity_1 = require("../zone/zone.entity");
const platform_module_1 = require("../platform/platform.module");
const branch_module_1 = require("../branch/branch.module");
let ProjectModule = class ProjectModule {
};
exports.ProjectModule = ProjectModule;
exports.ProjectModule = ProjectModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([project_entity_1.ProjectEntity, project_branch_entity_1.ProjectBranchEntity, assessment_entity_1.AssessmentEntity, call_log_entity_1.CallLogEntity, client_entity_1.ClientEntity, user_entity_1.UserEntity, zone_entity_1.ZoneEntity]),
            platform_module_1.PlatformModule,
            branch_module_1.BranchModule,
        ],
        controllers: [project_controller_1.ProjectController],
        providers: [project_service_1.ProjectService, project_query_service_1.ProjectQueryService],
        exports: [project_service_1.ProjectService, project_query_service_1.ProjectQueryService, typeorm_1.TypeOrmModule],
    })
], ProjectModule);
//# sourceMappingURL=project.module.js.map
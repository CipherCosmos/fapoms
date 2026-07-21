"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const validation_service_1 = require("./validation.service");
const validation_controller_1 = require("./validation.controller");
const validation_case_entity_1 = require("./validation-case.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
let ValidationModule = class ValidationModule {
};
exports.ValidationModule = ValidationModule;
exports.ValidationModule = ValidationModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([validation_case_entity_1.ValidationCaseEntity, project_branch_entity_1.ProjectBranchEntity]),
        ],
        controllers: [validation_controller_1.ValidationController],
        providers: [validation_service_1.ValidationService],
        exports: [validation_service_1.ValidationService],
    })
], ValidationModule);
//# sourceMappingURL=validation.module.js.map
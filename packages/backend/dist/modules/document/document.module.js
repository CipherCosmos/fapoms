"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const document_service_1 = require("./document.service");
const document_controller_1 = require("./document.controller");
const document_entity_1 = require("./document.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const storage_module_1 = require("../../infrastructure/storage/storage.module");
const ocr_module_1 = require("../../infrastructure/ocr/ocr.module");
let DocumentModule = class DocumentModule {
};
exports.DocumentModule = DocumentModule;
exports.DocumentModule = DocumentModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([document_entity_1.DocumentEntity, project_branch_entity_1.ProjectBranchEntity]),
            storage_module_1.StorageModule,
            ocr_module_1.OcrModule,
        ],
        controllers: [document_controller_1.DocumentController],
        providers: [document_service_1.DocumentService],
        exports: [document_service_1.DocumentService],
    })
], DocumentModule);
//# sourceMappingURL=document.module.js.map
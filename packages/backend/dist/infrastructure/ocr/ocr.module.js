"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OcrModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const ocr_processing_service_1 = require("./ocr-processing.service");
const ocr_boundary_controller_1 = require("./ocr-boundary.controller");
const ocr_job_entity_1 = require("./ocr-job.entity");
const document_entity_1 = require("../../modules/document/document.entity");
const validation_module_1 = require("../../modules/validation/validation.module");
let OcrModule = class OcrModule {
};
exports.OcrModule = OcrModule;
exports.OcrModule = OcrModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([ocr_job_entity_1.OcrJobEntity, document_entity_1.DocumentEntity]),
            validation_module_1.ValidationModule,
        ],
        controllers: [ocr_boundary_controller_1.OcrBoundaryController],
        providers: [ocr_processing_service_1.OcrProcessingService],
        exports: [ocr_processing_service_1.OcrProcessingService],
    })
], OcrModule);
//# sourceMappingURL=ocr.module.js.map
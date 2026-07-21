"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OcrBoundaryController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const ocr_processing_service_1 = require("./ocr-processing.service");
const guards_1 = require("../../modules/auth/guards");
const shared_1 = require("@fapoms/shared");
class ReceiveOcrResultsDto {
    externalJobId;
    ocrPayload;
}
let OcrBoundaryController = class OcrBoundaryController {
    ocrProcessingService;
    constructor(ocrProcessingService) {
        this.ocrProcessingService = ocrProcessingService;
    }
    async createJob(documentId, req) {
        const job = await this.ocrProcessingService.createJob(documentId, req.user.id);
        return {
            success: true,
            data: job,
        };
    }
    async callbackOcr(id, dto, req) {
        const job = await this.ocrProcessingService.receiveOcrResults(id, dto.externalJobId, dto.ocrPayload, req.user.id);
        return {
            success: true,
            data: job,
        };
    }
    async findOne(id) {
        const job = await this.ocrProcessingService.findOne(id);
        return {
            success: true,
            data: job,
        };
    }
};
exports.OcrBoundaryController = OcrBoundaryController;
__decorate([
    (0, common_1.Post)('jobs'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Create a new OCR tracking job request' }),
    __param(0, (0, common_1.Query)('documentId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], OcrBoundaryController.prototype, "createJob", null);
__decorate([
    (0, common_1.Post)('jobs/:id/results'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Callback endpoint to receive external OCR engine scan results' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, ReceiveOcrResultsDto, Object]),
    __metadata("design:returntype", Promise)
], OcrBoundaryController.prototype, "callbackOcr", null);
__decorate([
    (0, common_1.Get)('jobs/:id'),
    (0, swagger_1.ApiOperation)({ summary: 'Get status tracking details of an OCR job' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], OcrBoundaryController.prototype, "findOne", null);
exports.OcrBoundaryController = OcrBoundaryController = __decorate([
    (0, swagger_1.ApiTags)('OCR Integration Boundary'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard),
    (0, common_1.Controller)('ocr-boundary'),
    __metadata("design:paramtypes", [ocr_processing_service_1.OcrProcessingService])
], OcrBoundaryController);
//# sourceMappingURL=ocr-boundary.controller.js.map
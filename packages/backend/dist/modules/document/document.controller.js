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
exports.DocumentController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const platform_express_1 = require("@nestjs/platform-express");
const document_service_1 = require("./document.service");
const local_storage_service_1 = require("../../infrastructure/storage/local-storage.service");
const ocr_processing_service_1 = require("../../infrastructure/ocr/ocr-processing.service");
const guards_1 = require("../auth/guards");
const shared_1 = require("@fapoms/shared");
class UpdateDocumentStatusDto {
    status;
}
let DocumentController = class DocumentController {
    documentService;
    localStorageService;
    ocrProcessingService;
    constructor(documentService, localStorageService, ocrProcessingService) {
        this.documentService = documentService;
        this.localStorageService = localStorageService;
        this.ocrProcessingService = ocrProcessingService;
    }
    async uploadFile(file, projectBranchId, type, req) {
        const savedPath = await this.localStorageService.saveFile(file.originalname, file.buffer);
        const doc = await this.documentService.create({
            projectBranchId,
            fileName: file.originalname,
            filePath: savedPath,
            fileSize: file.size,
            mimeType: file.mimetype,
            type,
        }, req.user.id);
        await this.ocrProcessingService.createJob(doc.id, req.user.id);
        return {
            success: true,
            data: doc,
        };
    }
    async findOne(id) {
        const doc = await this.documentService.findOne(id);
        return {
            success: true,
            data: doc,
        };
    }
    async downloadFile(id, res) {
        const doc = await this.documentService.findOne(id);
        const fileStream = await this.localStorageService.getFileStream(doc.filePath);
        res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName}"`);
        fileStream.pipe(res);
    }
    async updateStatus(id, dto, req) {
        const doc = await this.documentService.updateStatus(id, dto.status, req.user.id);
        return {
            success: true,
            data: doc,
        };
    }
    async findByProjectBranch(projectBranchId) {
        const list = await this.documentService.findByProjectBranch(projectBranchId);
        return {
            success: true,
            data: list,
        };
    }
};
exports.DocumentController = DocumentController;
__decorate([
    (0, common_1.Post)('upload'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file')),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, swagger_1.ApiOperation)({ summary: 'Upload a physical file and trigger OCR queuing' }),
    __param(0, (0, common_1.UploadedFile)()),
    __param(1, (0, common_1.Query)('projectBranchId', common_1.ParseUUIDPipe)),
    __param(2, (0, common_1.Query)('type')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "uploadFile", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Get details of a document metadata' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "findOne", null);
__decorate([
    (0, common_1.Get)(':id/download'),
    (0, swagger_1.ApiOperation)({ summary: 'Download physical file payload from storage' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "downloadFile", null);
__decorate([
    (0, common_1.Patch)(':id/status'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Update status of a document' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, UpdateDocumentStatusDto, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "updateStatus", null);
__decorate([
    (0, common_1.Get)('project-branch/:projectBranchId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get documents for a project branch link' }),
    __param(0, (0, common_1.Param)('projectBranchId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "findByProjectBranch", null);
exports.DocumentController = DocumentController = __decorate([
    (0, swagger_1.ApiTags)('Documents'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard),
    (0, common_1.Controller)('documents'),
    __metadata("design:paramtypes", [document_service_1.DocumentService,
        local_storage_service_1.LocalStorageService,
        ocr_processing_service_1.OcrProcessingService])
], DocumentController);
//# sourceMappingURL=document.controller.js.map
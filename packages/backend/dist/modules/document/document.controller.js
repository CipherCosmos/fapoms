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
const xlsx = require("xlsx");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const document_service_1 = require("./document.service");
const local_storage_service_1 = require("../../infrastructure/storage/local-storage.service");
const ocr_processing_service_1 = require("../../infrastructure/ocr/ocr-processing.service");
const assessment_entity_1 = require("../project/assessment.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const guards_1 = require("../auth/guards");
const shared_1 = require("@fapoms/shared");
let DocumentController = class DocumentController {
    documentService;
    localStorageService;
    ocrProcessingService;
    assignmentRepository;
    assessmentRepository;
    constructor(documentService, localStorageService, ocrProcessingService, assignmentRepository, assessmentRepository) {
        this.documentService = documentService;
        this.localStorageService = localStorageService;
        this.ocrProcessingService = ocrProcessingService;
        this.assignmentRepository = assignmentRepository;
        this.assessmentRepository = assessmentRepository;
    }
    async uploadFile(file, assessmentId, type, req) {
        const savedPath = await this.localStorageService.saveFile(file.originalname, file.buffer);
        const doc = await this.documentService.create({
            assessmentId,
            fileName: file.originalname,
            filePath: savedPath,
            fileSize: file.size,
            mimeType: file.mimetype,
            type,
        }, req?.user?.id || assessmentId);
        if (type === shared_1.DocumentType.CUSTOMER_MASTER_DATA) {
            await this.ocrProcessingService.createJob(doc.id, req?.user?.id || assessmentId);
        }
        return { success: true, data: doc };
    }
    async mobileUpload(body, req) {
        const assessmentId = body.assessmentId;
        const doc = await this.documentService.create({
            assessmentId,
            fileName: body.fileName || `audit_${assessmentId}.pdf`,
            filePath: body.fileData
                ? await this.localStorageService.saveFile(body.fileName || 'report.pdf', Buffer.from(body.fileData, 'base64'))
                : `mobile-upload:/${assessmentId}/${body.fileName || 'report.pdf'}`,
            fileSize: 0,
            mimeType: 'application/pdf',
            type: shared_1.DocumentType.AUDITED_RETURN_PDF,
        }, req?.user?.id || '00000000-0000-0000-0000-000000000000');
        await this.documentService.receiveDocument(doc.id, req?.user?.id || 'SYSTEM').catch(() => { });
        return { success: true, data: doc, documentUrl: `/documents/${doc.id}/download` };
    }
    async validateCustomerExcel(file) {
        const workbook = xlsx.read(file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
        let totalRows = rows.length;
        let duplicateAccountsCount = 0;
        let missingBranchesCount = 0;
        const accountNumbersSeen = new Set();
        const branchCodesSeen = new Set();
        for (const row of rows) {
            const acc = String(row['Account Number'] || row.ACCOUNT_NO || row.AccountNo || '').trim();
            const branchCode = String(row['Branch Code'] || row.BRANCH_CODE || row.BranchCode || '').trim();
            if (acc) {
                if (accountNumbersSeen.has(acc))
                    duplicateAccountsCount++;
                else
                    accountNumbersSeen.add(acc);
            }
            if (branchCode) {
                branchCodesSeen.add(branchCode);
            }
            else {
                missingBranchesCount++;
            }
        }
        const status = (duplicateAccountsCount > 50 || missingBranchesCount > 10) ? 'IMPORT_BLOCKED' : 'VALIDATED_READY_FOR_IMPORT';
        return {
            success: true,
            data: {
                summary: {
                    totalRowsProcessed: totalRows,
                    uniqueAccountsCount: accountNumbersSeen.size,
                    duplicateAccountsCount,
                    uniqueBranchesCount: branchCodesSeen.size,
                    missingBranchCodesCount: missingBranchesCount,
                    status,
                },
                recommendation: status === 'IMPORT_BLOCKED'
                    ? 'Reconciliation Blocked: Fix duplicate account numbers or missing branch codes in Excel sheet before proceeding.'
                    : 'Reconciliation Passed: Ready for OCR generation and assignment mapping.',
            },
        };
    }
    async findOne(id) {
        const doc = await this.documentService.findOne(id);
        return { success: true, data: doc };
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
        return { success: true, data: doc };
    }
    async dispatchDocument(id, req) {
        const userId = req?.user?.id || id;
        const doc = await this.documentService.dispatchDocument(id, userId);
        return { success: true, data: doc, message: 'Document dispatched to assessor.' };
    }
    async receiveDocument(id, req) {
        const userId = req?.user?.id || id;
        const doc = await this.documentService.receiveDocument(id, userId);
        return { success: true, data: doc, message: 'Document marked as received.' };
    }
    async findByAssessment(assessmentId) {
        const list = await this.documentService.findByAssessment(assessmentId);
        return { success: true, data: list };
    }
    async findByProject(projectId) {
        const list = await this.documentService.findByProject(projectId);
        return { success: true, data: list };
    }
    async getStats() {
        const stats = await this.documentService.getDocumentStats();
        return { success: true, data: stats };
    }
    async getDataEntryQueue() {
        const queue = await this.documentService.findDataEntryQueue();
        return { success: true, data: queue };
    }
};
exports.DocumentController = DocumentController;
__decorate([
    (0, common_1.Post)('upload'),
    (0, guards_1.Public)(),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file')),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, swagger_1.ApiOperation)({ summary: 'Upload a file for an assessment' }),
    __param(0, (0, common_1.UploadedFile)()),
    __param(1, (0, common_1.Query)('assessmentId', common_1.ParseUUIDPipe)),
    __param(2, (0, common_1.Query)('type')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "uploadFile", null);
__decorate([
    (0, common_1.Post)('mobile-upload'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Mobile JSON-based document upload (no multipart)' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "mobileUpload", null);
__decorate([
    (0, common_1.Post)('validate-customer-excel'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DOCUMENT_EXECUTIVE, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('document:create:organization'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file')),
    (0, swagger_1.ApiOperation)({ summary: 'Validate Customer Master Excel file' }),
    __param(0, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "validateCustomerExcel", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Get document metadata' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "findOne", null);
__decorate([
    (0, common_1.Get)(':id/download'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Download physical file from storage' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "downloadFile", null);
__decorate([
    (0, common_1.Patch)(':id/status'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, guards_1.RequirePermissions)('document:update:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Update document status' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "updateStatus", null);
__decorate([
    (0, common_1.Post)(':id/dispatch'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Dispatch a document to the assigned assessor' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "dispatchDocument", null);
__decorate([
    (0, common_1.Post)(':id/receive'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Mark a dispatched document as received back' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "receiveDocument", null);
__decorate([
    (0, common_1.Get)('assessment/:assessmentId'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Get documents for an assessment' }),
    __param(0, (0, common_1.Param)('assessmentId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "findByAssessment", null);
__decorate([
    (0, common_1.Get)('project/:projectId'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Get all documents for a project' }),
    __param(0, (0, common_1.Param)('projectId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "findByProject", null);
__decorate([
    (0, common_1.Get)('stats/summary'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Get document statistics' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "getStats", null);
__decorate([
    (0, common_1.Get)('queue/data-entry'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Get data entry queue — all received PDFs grouped by assessment' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "getDataEntryQueue", null);
exports.DocumentController = DocumentController = __decorate([
    (0, swagger_1.ApiTags)('Documents'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard, guards_1.PermissionsGuard),
    (0, common_1.Controller)('documents'),
    __param(3, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __param(4, (0, typeorm_1.InjectRepository)(assessment_entity_1.AssessmentEntity)),
    __metadata("design:paramtypes", [document_service_1.DocumentService,
        local_storage_service_1.LocalStorageService,
        ocr_processing_service_1.OcrProcessingService,
        typeorm_2.Repository,
        typeorm_2.Repository])
], DocumentController);
//# sourceMappingURL=document.controller.js.map
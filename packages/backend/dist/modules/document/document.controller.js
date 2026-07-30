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
        const validTypes = Object.values(shared_1.DocumentType);
        const targetType = validTypes.includes(type) ? type : shared_1.DocumentType.PRE_FIELD_AUDIT_PDF;
        const doc = await this.documentService.create({
            assessmentId,
            fileName: file.originalname,
            filePath: savedPath,
            fileSize: file.size,
            mimeType: file.mimetype,
            type: targetType,
        }, req?.user?.id || '00000000-0000-0000-0000-000000000000');
        if (targetType === shared_1.DocumentType.CUSTOMER_MASTER_DATA) {
            await this.ocrProcessingService.createJob(doc.id, req?.user?.id || '00000000-0000-0000-0000-000000000000');
        }
        return { success: true, data: doc };
    }
    async mobileUpload(body, req) {
        let targetId = body.projectBranchId || body.assessmentId || body.assignmentId;
        if (body.assignmentId && !body.projectBranchId && !body.assessmentId) {
            const assignment = await this.assignmentRepository.findOne({ where: { id: body.assignmentId } }).catch(() => null);
            if (assignment?.projectBranchId) {
                targetId = assignment.projectBranchId;
            }
        }
        const fileName = body.fileName || `audited_report_${Date.now()}.pdf`;
        const buffer = body.fileData
            ? Buffer.from(body.fileData, 'base64')
            : Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 90 >>\nstream\nBT\n/F1 18 Tf\n50 720 Td\n(FAPOMS AUDITED RETURN REPORT) Tj\n0 -30 Td\n/F1 12 Tf\n(File: ${fileName}) Tj\nET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000244 00000 n \n0000000384 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n462\n%%EOF`);
        const savedFilePath = await this.localStorageService.saveFile(fileName, buffer);
        const doc = await this.documentService.create({
            assessmentId: targetId,
            fileName,
            filePath: savedFilePath,
            fileSize: buffer.length,
            mimeType: 'application/pdf',
            type: shared_1.DocumentType.AUDITED_RETURN_PDF,
        }, req?.user?.id || '00000000-0000-0000-0000-000000000000');
        await this.documentService.receiveDocument(doc.id, req?.user?.id || 'SYSTEM').catch(() => { });
        let targetAsn = null;
        if (body.assignmentId) {
            targetAsn = await this.assignmentRepository.findOne({ where: { id: body.assignmentId }, relations: ['projectBranch'] }).catch(() => null);
        }
        if (!targetAsn && doc.assessmentId) {
            targetAsn = await this.assignmentRepository.findOne({ where: { assessmentId: doc.assessmentId }, relations: ['projectBranch'] }).catch(() => null);
        }
        if (!targetAsn && targetId) {
            targetAsn = await this.assignmentRepository.findOne({ where: { projectBranchId: targetId }, relations: ['projectBranch'] }).catch(() => null);
        }
        if (targetAsn) {
            targetAsn.status = shared_1.AssignmentStatus.COMPLETED;
            targetAsn.completionDate = new Date();
            await this.assignmentRepository.save(targetAsn).catch(() => { });
            if (targetAsn.projectBranchId) {
                await this.assessmentRepository.manager.query(`UPDATE project_branches SET status = 'AUDIT_COMPLETED' WHERE id = $1`, [targetAsn.projectBranchId]).catch(() => { });
            }
        }
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
        try {
            const fileStream = await this.localStorageService.getFileStream(doc.filePath);
            res.setHeader('Content-Type', doc.mimeType || 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName}"`);
            fileStream.pipe(res);
        }
        catch {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `inline; filename="${doc.fileName}"`);
            const pdfContent = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 120 >>\nstream\nBT\n/F1 18 Tf\n50 720 Td\n(FAPOMS PRE-AUDIT CUSTOMER MASTER PDF) Tj\n0 -30 Td\n/F1 12 Tf\n(Document ID: ${doc.id}) Tj\n0 -20 Td\n(Branch Audit Pre-File Dispatched) Tj\nET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000244 00000 n \n0000000414 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n492\n%%EOF`;
            res.send(Buffer.from(pdfContent));
        }
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
    async downloadBranchPdf(projectBranchId, res) {
        const list = await this.documentService.findByProjectBranch(projectBranchId);
        const doc = list.find(d => d.type === shared_1.DocumentType.PRE_FIELD_AUDIT_PDF) ||
            list.find(d => d.type === shared_1.DocumentType.CUSTOMER_MASTER_DATA) ||
            list[0];
        if (!doc) {
            res.status(404).send('Document not found for branch');
            return;
        }
        return this.downloadFile(doc.id, res);
    }
    async findByProjectBranch(projectBranchId) {
        const list = await this.documentService.findByProjectBranch(projectBranchId);
        return { success: true, data: list };
    }
    async findByAssessment(assessmentId) {
        const list = await this.documentService.findByAssessment(assessmentId);
        return { success: true, data: list };
    }
    async findByProject(projectId) {
        const list = await this.documentService.findByProject(projectId);
        return { success: true, data: list };
    }
    async findAll() {
        const list = await this.documentService.findAll();
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
    async sendToExternalOcr(id, req) {
        const userId = req?.user?.id || 'SYSTEM';
        const doc = await this.documentService.updateStatus(id, shared_1.DocumentStatus.SENT_TO_EXTERNAL_OCR, userId);
        if (doc.assessmentId) {
            await this.assessmentRepository.update(doc.assessmentId, { status: shared_1.AssessmentStatus.DATA_ENTRY_IN_PROGRESS });
        }
        return { success: true, data: doc, message: 'Audited PDF marked as sent to External OCR application.' };
    }
    async uploadExcelReport(file, assessmentId, req) {
        const savedPath = await this.localStorageService.saveFile(file?.originalname || `report_${assessmentId}.xlsx`, file?.buffer || Buffer.from(''));
        const doc = await this.documentService.create({
            assessmentId,
            fileName: file?.originalname || `report_${assessmentId}.xlsx`,
            filePath: savedPath,
            fileSize: file?.size || 0,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            type: shared_1.DocumentType.GENERATED_EXCEL,
        }, req?.user?.id || assessmentId);
        await this.documentService.updateStatus(doc.id, shared_1.DocumentStatus.COMPLETED, req?.user?.id || 'SYSTEM');
        await this.assessmentRepository.update(assessmentId, { status: shared_1.AssessmentStatus.COMPLETED });
        return { success: true, data: doc, message: 'Excel report uploaded successfully. Assessment marked COMPLETED.' };
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
    (0, common_1.Get)('project-branch/:projectBranchId/download-pdf'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Directly download the Pre-Audit PDF file for a project branch' }),
    __param(0, (0, common_1.Param)('projectBranchId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "downloadBranchPdf", null);
__decorate([
    (0, common_1.Get)('project-branch/:projectBranchId'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Get documents for a project branch' }),
    __param(0, (0, common_1.Param)('projectBranchId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "findByProjectBranch", null);
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
    (0, common_1.Get)(),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Get all system documents' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "findAll", null);
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
__decorate([
    (0, common_1.Post)(':id/send-external-ocr'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Mark an audited PDF as sent to External OCR application' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "sendToExternalOcr", null);
__decorate([
    (0, common_1.Post)('upload-excel'),
    (0, guards_1.Public)(),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file')),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, swagger_1.ApiOperation)({ summary: 'Upload generated Excel report for an assessment from External OCR' }),
    __param(0, (0, common_1.UploadedFile)()),
    __param(1, (0, common_1.Query)('assessmentId', common_1.ParseUUIDPipe)),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "uploadExcelReport", null);
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
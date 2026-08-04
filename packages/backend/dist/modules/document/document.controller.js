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
const validation_service_1 = require("../validation/validation.service");
const document_access_token_service_1 = require("./document-access-token.service");
const chunked_upload_service_1 = require("./chunked-upload.service");
const assignment_service_1 = require("../assignment/assignment.service");
let DocumentController = class DocumentController {
    documentService;
    localStorageService;
    ocrProcessingService;
    assignmentRepository;
    assessmentRepository;
    validationService;
    assignmentService;
    documentAccessTokenService;
    chunkedUploadService;
    constructor(documentService, localStorageService, ocrProcessingService, assignmentRepository, assessmentRepository, validationService, assignmentService, documentAccessTokenService, chunkedUploadService) {
        this.documentService = documentService;
        this.localStorageService = localStorageService;
        this.ocrProcessingService = ocrProcessingService;
        this.assignmentRepository = assignmentRepository;
        this.assessmentRepository = assessmentRepository;
        this.validationService = validationService;
        this.assignmentService = assignmentService;
        this.documentAccessTokenService = documentAccessTokenService;
        this.chunkedUploadService = chunkedUploadService;
    }
    async uploadFile(file, assessmentId, type, req, customerMasterVersionId) {
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
            customerMasterVersionId,
        }, req?.user?.id || '00000000-0000-0000-0000-000000000000');
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
        if (!body.fileData) {
            throw new common_1.BadRequestException('No file content received (fileData is required, base64-encoded). The audited return PDF must be a real uploaded file.');
        }
        const buffer = Buffer.from(body.fileData, 'base64');
        if (buffer.length === 0) {
            throw new common_1.BadRequestException('Uploaded file is empty.');
        }
        const savedFilePath = await this.localStorageService.saveFile(fileName, buffer);
        const doc = await this.documentService.create({
            assessmentId: targetId,
            fileName,
            filePath: savedFilePath,
            fileSize: buffer.length,
            mimeType: 'application/pdf',
            type: shared_1.DocumentType.AUDITED_RETURN_PDF,
        }, req?.user?.id || '00000000-0000-0000-0000-000000000000');
        try {
            await this.documentService.receiveDocument(doc.id, req?.user?.id || 'SYSTEM');
        }
        catch (err) {
            console.error(`Audited return ${doc.id} uploaded but could not be marked received — it will not appear in the data-entry queue:`, err?.message);
        }
        await this.completeAssignmentForReturn(doc, body.assignmentId, targetId, req?.user?.id || 'SYSTEM', fileName);
        return { success: true, data: doc, documentUrl: `/documents/${doc.id}/download` };
    }
    async mobileUploadBinary(file, assessmentId, assignmentId, req) {
        if (!file?.buffer?.length) {
            throw new common_1.BadRequestException('No file content received.');
        }
        let targetId = assessmentId || assignmentId;
        if (assignmentId && !assessmentId) {
            const assignment = await this.assignmentRepository
                .findOne({ where: { id: assignmentId } })
                .catch(() => null);
            if (assignment?.projectBranchId)
                targetId = assignment.projectBranchId;
        }
        const savedFilePath = await this.localStorageService.saveFile(file.originalname, file.buffer);
        const doc = await this.documentService.create({
            assessmentId: targetId,
            fileName: file.originalname,
            filePath: savedFilePath,
            fileSize: file.size,
            mimeType: file.mimetype || 'application/pdf',
            type: shared_1.DocumentType.AUDITED_RETURN_PDF,
        }, req.user.id);
        try {
            await this.documentService.receiveDocument(doc.id, req.user.id);
        }
        catch (err) {
            console.error(`Audited return ${doc.id} could not be marked received:`, err?.message);
        }
        await this.completeAssignmentForReturn(doc, assignmentId, targetId, req.user.id, file.originalname);
        return { success: true, data: doc };
    }
    async createUploadSession(body, req) {
        if (!body?.assessmentId || !body?.fileName) {
            throw new common_1.BadRequestException('assessmentId and fileName are required.');
        }
        const session = this.chunkedUploadService.createSession({
            assessmentId: body.assessmentId,
            fileName: body.fileName,
            fileSize: Number(body.fileSize),
            chunkSize: body.chunkSize ? Number(body.chunkSize) : undefined,
            createdBy: req.user.id,
        });
        return { success: true, data: session };
    }
    async getUploadSession(uploadId) {
        const session = this.chunkedUploadService.getSession(uploadId);
        const received = this.chunkedUploadService.receivedChunks(uploadId);
        const missing = [];
        for (let i = 0; i < session.totalChunks; i++)
            if (!received.includes(i))
                missing.push(i);
        return {
            success: true,
            data: {
                ...session,
                receivedChunks: received,
                missingChunks: missing,
                progress: Math.round((received.length / session.totalChunks) * 100),
            },
        };
    }
    async uploadChunk(uploadId, index, chunk) {
        if (!chunk?.buffer) {
            throw new common_1.BadRequestException('No chunk content received.');
        }
        const progress = this.chunkedUploadService.saveChunk(uploadId, Number(index), chunk.buffer);
        return { success: true, data: { ...progress, index: Number(index) } };
    }
    async completeUpload(uploadId, body, req) {
        const { buffer, session } = this.chunkedUploadService.assemble(uploadId);
        const type = body?.type && Object.values(shared_1.DocumentType).includes(body.type)
            ? body.type
            : shared_1.DocumentType.AUDITED_RETURN_PDF;
        const savedFilePath = await this.localStorageService.saveFile(session.fileName, buffer);
        const doc = await this.documentService.create({
            assessmentId: session.assessmentId,
            fileName: session.fileName,
            filePath: savedFilePath,
            fileSize: buffer.length,
            mimeType: 'application/pdf',
            type,
        }, req.user.id);
        this.chunkedUploadService.discard(uploadId);
        if (type === shared_1.DocumentType.AUDITED_RETURN_PDF) {
            try {
                await this.documentService.receiveDocument(doc.id, req.user.id);
            }
            catch (err) {
                console.error(`Chunked audited return ${doc.id} could not be marked received:`, err?.message);
            }
            await this.completeAssignmentForReturn(doc, body?.assignmentId, session.assessmentId, req.user.id, session.fileName);
        }
        return { success: true, data: doc };
    }
    async completeAssignmentForReturn(doc, assignmentId, fallbackTargetId, userId, fileName) {
        let targetAsn = null;
        if (assignmentId) {
            targetAsn = await this.assignmentRepository
                .findOne({ where: { id: assignmentId }, relations: ['projectBranch'] })
                .catch(() => null);
        }
        if (!targetAsn && doc.assessmentId) {
            targetAsn = await this.assignmentRepository
                .findOne({ where: { assessmentId: doc.assessmentId }, relations: ['projectBranch'] })
                .catch(() => null);
        }
        if (!targetAsn && fallbackTargetId) {
            targetAsn = await this.assignmentRepository
                .findOne({ where: { projectBranchId: fallbackTargetId }, relations: ['projectBranch'] })
                .catch(() => null);
        }
        if (targetAsn && targetAsn.status !== shared_1.AssignmentStatus.COMPLETED) {
            try {
                await this.assignmentService.completeAssignment(targetAsn.id, userId, `Audited return PDF uploaded (${fileName})`);
            }
            catch (err) {
                console.error(`Failed to complete assignment ${targetAsn.id} after audited-return upload:`, err?.message);
            }
        }
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
            const branchCode = String(row['Branch Code'] || row.BRANCH_CODE || row.BranchCode || row['BRANCH'] || row.Branch || '').trim();
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
    async downloadFile(id, token, req, res) {
        this.documentAccessTokenService.verify(id, token);
        const doc = await this.documentService.findOne(id);
        let stat;
        try {
            stat = await this.localStorageService.statFile(doc.filePath);
        }
        catch {
            throw new common_1.NotFoundException(`File for document ${id} is missing from storage (${doc.filePath}). It may not have been uploaded successfully.`);
        }
        const etag = `"${id}-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', doc.mimeType || 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName}"`);
        if (req.headers['if-none-match'] === etag) {
            res.status(304).end();
            return;
        }
        const range = req.headers.range;
        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
            if (match) {
                const start = match[1] ? parseInt(match[1], 10) : 0;
                const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
                if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
                    res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
                    res.end();
                    return;
                }
                const clampedEnd = Math.min(end, stat.size - 1);
                res.status(206);
                res.setHeader('Content-Range', `bytes ${start}-${clampedEnd}/${stat.size}`);
                res.setHeader('Content-Length', clampedEnd - start + 1);
                const partial = await this.localStorageService.getFileStream(doc.filePath, start, clampedEnd);
                partial.pipe(res);
                return;
            }
        }
        res.setHeader('Content-Length', stat.size);
        const fileStream = await this.localStorageService.getFileStream(doc.filePath);
        fileStream.pipe(res);
    }
    async issueDownloadToken(id, req) {
        await this.documentService.findOne(id);
        const roles = (req.user?.roles ?? []).map((r) => r?.name ?? r);
        const isPrivileged = roles.some((r) => r !== shared_1.SystemRole.ASSAYER);
        if (!isPrivileged && roles.includes(shared_1.SystemRole.ASSAYER)) {
            await this.documentService.assertAssayerMayDownload(id, req.user.assayerId ?? req.user.id);
        }
        const { token, expiresAt } = this.documentAccessTokenService.issue(id);
        return {
            success: true,
            data: { downloadUrl: `/documents/${id}/download?token=${token}`, token, expiresAt },
        };
    }
    async getTransportTrail(id) {
        const doc = await this.documentService.findOne(id);
        return {
            success: true,
            data: {
                documentId: doc.id,
                fileName: doc.fileName,
                type: doc.type,
                status: doc.status,
                assessmentId: doc.assessmentId,
                branch: doc.assessment?.branch?.name ?? null,
                project: doc.assessment?.project?.name ?? null,
                trail: this.documentService.buildTransportTrail(doc),
            },
        };
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
    async downloadBranchPdf(projectBranchId, req, res) {
        const { documents, readiness } = await this.documentService.findDispatchedForAssayer(projectBranchId);
        const doc = documents.find(d => d.type === shared_1.DocumentType.PRE_FIELD_AUDIT_PDF) ||
            documents.find(d => d.type === shared_1.DocumentType.CUSTOMER_MASTER_DATA) ||
            documents[0];
        if (!doc) {
            res.status(404).json({ success: false, message: readiness.message, readiness });
            return;
        }
        const { token } = this.documentAccessTokenService.issue(doc.id);
        return this.downloadFile(doc.id, token, req, res);
    }
    async findByProjectBranch(projectBranchId, req) {
        const roles = (req.user?.roles ?? []).map((r) => r?.name ?? r);
        const assayerOnly = roles.includes(shared_1.SystemRole.ASSAYER) && !roles.some((r) => r !== shared_1.SystemRole.ASSAYER);
        if (assayerOnly) {
            const { documents, readiness } = await this.documentService.findDispatchedForAssayer(projectBranchId);
            return { success: true, data: documents, meta: { readiness } };
        }
        const list = await this.documentService.findByProjectBranch(projectBranchId);
        return { success: true, data: list };
    }
    async operationsOverview(projectId, status, type) {
        return { success: true, data: await this.documentService.operationsOverview({ projectId, status, type }) };
    }
    async uploadGeneratedBatch(files, projectId, auditDate, req, customerMasterVersionId) {
        if (!files?.length)
            throw new common_1.BadRequestException('No files received.');
        if (!auditDate)
            throw new common_1.BadRequestException('auditDate is required.');
        const { matches, unmatched, branchesWithoutFile } = await this.documentService.matchPdfsToBranches(projectId, auditDate, files.map((f) => f.originalname));
        const byName = new Map(files.map((f) => [f.originalname, f]));
        const created = [];
        const failed = [];
        for (const m of matches) {
            const file = byName.get(m.fileName);
            if (!file)
                continue;
            try {
                const savedPath = await this.localStorageService.saveFile(file.originalname, file.buffer);
                const doc = await this.documentService.create({
                    assessmentId: m.projectBranchId,
                    fileName: file.originalname,
                    filePath: savedPath,
                    fileSize: file.size,
                    mimeType: file.mimetype,
                    type: shared_1.DocumentType.PRE_FIELD_AUDIT_PDF,
                    customerMasterVersionId,
                }, req.user.id);
                created.push({ documentId: doc.id, fileName: file.originalname, branchName: m.branchName });
            }
            catch (err) {
                failed.push({ fileName: file.originalname, reason: err.message });
            }
        }
        return {
            success: true,
            data: { created, unmatched, failed, branchesWithoutFile },
            message: `Filed ${created.length} of ${files.length} packet(s).` +
                (unmatched.length ? ` ${unmatched.length} could not be matched to a branch.` : '') +
                (branchesWithoutFile.length ? ` ${branchesWithoutFile.length} scheduled branch(es) still have no packet.` : ''),
        };
    }
    async dispatchBatch(body, req) {
        if (!body?.documentIds?.length) {
            throw new common_1.BadRequestException('documentIds is required.');
        }
        const result = await this.documentService.dispatchMany(body.documentIds, req.user.id);
        return {
            success: true,
            data: result,
            message: `Dispatched ${result.dispatched.length} document(s)${result.failed.length ? `, ${result.failed.length} failed` : ''}.`,
        };
    }
    async assayerBranchDocuments(projectBranchId) {
        const { documents, readiness } = await this.documentService.findDispatchedForAssayer(projectBranchId);
        return { success: true, data: documents, meta: { readiness } };
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
        const doc = await this.documentService.markSentToExternalOcr(id, req.user.id);
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
    async dataEntryQueue(assignedTo) {
        return { success: true, data: await this.documentService.dataEntryQueue(assignedTo) };
    }
    async myDataEntryQueue(req) {
        return { success: true, data: await this.documentService.dataEntryQueue(req.user.id) };
    }
    async dataEntryTeam() {
        return { success: true, data: await this.documentService.dataEntryTeam() };
    }
    async assignDataEntry(id, body, req) {
        const doc = await this.documentService.assignForDataEntry(id, body.assigneeId, req.user.id);
        return { success: true, data: doc };
    }
    async completeDataEntry(id, req) {
        const doc = await this.documentService.completeDataEntry(id, req.user.id);
        return { success: true, data: doc };
    }
};
exports.DocumentController = DocumentController;
__decorate([
    (0, common_1.Post)('upload'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file')),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, swagger_1.ApiOperation)({ summary: 'Upload a file for an assessment' }),
    __param(0, (0, common_1.UploadedFile)()),
    __param(1, (0, common_1.Query)('assessmentId', common_1.ParseUUIDPipe)),
    __param(2, (0, common_1.Query)('type')),
    __param(3, (0, common_1.Req)()),
    __param(4, (0, common_1.Query)('customerMasterVersionId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object, String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "uploadFile", null);
__decorate([
    (0, common_1.Post)('mobile-upload'),
    (0, guards_1.Roles)(shared_1.SystemRole.ASSAYER, shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Mobile JSON-based document upload (no multipart)' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "mobileUpload", null);
__decorate([
    (0, common_1.Post)('mobile-upload-binary'),
    (0, guards_1.Roles)(shared_1.SystemRole.ASSAYER, shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file')),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, swagger_1.ApiOperation)({ summary: 'Binary audited-return upload (no base64 inflation)' }),
    __param(0, (0, common_1.UploadedFile)()),
    __param(1, (0, common_1.Query)('assessmentId')),
    __param(2, (0, common_1.Query)('assignmentId')),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "mobileUploadBinary", null);
__decorate([
    (0, common_1.Post)('upload/session'),
    (0, guards_1.Roles)(shared_1.SystemRole.ASSAYER, shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Open a resumable upload session' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "createUploadSession", null);
__decorate([
    (0, common_1.Get)('upload/session/:uploadId'),
    (0, guards_1.Roles)(shared_1.SystemRole.ASSAYER, shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Resume: report which chunks the server already holds' }),
    __param(0, (0, common_1.Param)('uploadId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "getUploadSession", null);
__decorate([
    (0, common_1.Put)('upload/session/:uploadId/chunk/:index'),
    (0, guards_1.Roles)(shared_1.SystemRole.ASSAYER, shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('chunk')),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, swagger_1.ApiOperation)({ summary: 'Upload one chunk (binary, resumable)' }),
    __param(0, (0, common_1.Param)('uploadId')),
    __param(1, (0, common_1.Param)('index')),
    __param(2, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "uploadChunk", null);
__decorate([
    (0, common_1.Post)('upload/session/:uploadId/complete'),
    (0, guards_1.Roles)(shared_1.SystemRole.ASSAYER, shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Assemble the chunks into the final document' }),
    __param(0, (0, common_1.Param)('uploadId')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "completeUpload", null);
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
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE, shared_1.SystemRole.VALIDATION_MANAGER, shared_1.SystemRole.VALIDATOR, shared_1.SystemRole.DATA_ENTRY_HEAD, shared_1.SystemRole.READ_ONLY_AUDITOR),
    (0, swagger_1.ApiOperation)({ summary: 'Get document metadata' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "findOne", null);
__decorate([
    (0, common_1.Get)(':id/download'),
    (0, guards_1.Public)(),
    (0, swagger_1.ApiOperation)({ summary: 'Download a document using a short-lived signed token' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Query)('token')),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "downloadFile", null);
__decorate([
    (0, common_1.Get)(':id/download-token'),
    (0, guards_1.Roles)(shared_1.SystemRole.ASSAYER, shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE, shared_1.SystemRole.DATA_ENTRY_HEAD, shared_1.SystemRole.VALIDATION_MANAGER, shared_1.SystemRole.VALIDATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Issue a short-lived signed download URL for a document' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "issueDownloadToken", null);
__decorate([
    (0, common_1.Get)(':id/trail'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE, shared_1.SystemRole.VALIDATION_MANAGER, shared_1.SystemRole.VALIDATOR, shared_1.SystemRole.DATA_ENTRY_HEAD, shared_1.SystemRole.READ_ONLY_AUDITOR),
    (0, swagger_1.ApiOperation)({ summary: 'Full transport/chain-of-custody trail for a document' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "getTransportTrail", null);
__decorate([
    (0, common_1.Patch)(':id/status'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, guards_1.RequirePermissions)('document:edit:organization'),
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
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Dispatch a document to the assigned assessor' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "dispatchDocument", null);
__decorate([
    (0, common_1.Post)(':id/receive'),
    (0, guards_1.Roles)(shared_1.SystemRole.ASSAYER, shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Mark a dispatched document as received back' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "receiveDocument", null);
__decorate([
    (0, common_1.Get)('project-branch/:projectBranchId/download-pdf'),
    (0, swagger_1.ApiOperation)({ summary: 'Directly download the Pre-Audit PDF file for a project branch' }),
    __param(0, (0, common_1.Param)('projectBranchId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "downloadBranchPdf", null);
__decorate([
    (0, common_1.Get)('project-branch/:projectBranchId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get documents for a project branch' }),
    __param(0, (0, common_1.Param)('projectBranchId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "findByProjectBranch", null);
__decorate([
    (0, common_1.Get)('operations/overview'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE, shared_1.SystemRole.DATA_ENTRY_HEAD),
    (0, swagger_1.ApiOperation)({ summary: 'Document control console: branch context, transport trail, pipeline and action queues' }),
    __param(0, (0, common_1.Query)('projectId')),
    __param(1, (0, common_1.Query)('status')),
    __param(2, (0, common_1.Query)('type')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "operationsOverview", null);
__decorate([
    (0, common_1.Post)('upload-generated-batch'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, common_1.UseInterceptors)((0, platform_express_1.FilesInterceptor)('files', 100)),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, swagger_1.ApiOperation)({ summary: "Upload a day's generated audit PDFs together, matching each file to its branch by filename" }),
    __param(0, (0, common_1.UploadedFiles)()),
    __param(1, (0, common_1.Query)('projectId', common_1.ParseUUIDPipe)),
    __param(2, (0, common_1.Query)('auditDate')),
    __param(3, (0, common_1.Req)()),
    __param(4, (0, common_1.Query)('customerMasterVersionId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Array, String, String, Object, String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "uploadGeneratedBatch", null);
__decorate([
    (0, common_1.Post)('dispatch-batch'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Release several documents to their assayers in one action' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "dispatchBatch", null);
__decorate([
    (0, common_1.Get)('project-branch/:projectBranchId/assayer-view'),
    (0, guards_1.Roles)(shared_1.SystemRole.ASSAYER, shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE, shared_1.SystemRole.VALIDATION_MANAGER, shared_1.SystemRole.VALIDATOR, shared_1.SystemRole.DATA_ENTRY_HEAD, shared_1.SystemRole.READ_ONLY_AUDITOR),
    (0, swagger_1.ApiOperation)({ summary: "Dispatch-gated documents for a branch, with readiness so the field app can explain what to expect" }),
    __param(0, (0, common_1.Param)('projectBranchId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "assayerBranchDocuments", null);
__decorate([
    (0, common_1.Get)('assessment/:assessmentId'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE, shared_1.SystemRole.VALIDATION_MANAGER, shared_1.SystemRole.VALIDATOR, shared_1.SystemRole.DATA_ENTRY_HEAD, shared_1.SystemRole.READ_ONLY_AUDITOR),
    (0, swagger_1.ApiOperation)({ summary: 'Get documents for an assessment' }),
    __param(0, (0, common_1.Param)('assessmentId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "findByAssessment", null);
__decorate([
    (0, common_1.Get)('project/:projectId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get all documents for a project' }),
    __param(0, (0, common_1.Param)('projectId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "findByProject", null);
__decorate([
    (0, common_1.Get)(),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE, shared_1.SystemRole.VALIDATION_MANAGER, shared_1.SystemRole.VALIDATOR, shared_1.SystemRole.DATA_ENTRY_HEAD, shared_1.SystemRole.READ_ONLY_AUDITOR),
    (0, swagger_1.ApiOperation)({ summary: 'Get all system documents' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)('stats/summary'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE, shared_1.SystemRole.DOCUMENT_EXECUTIVE, shared_1.SystemRole.VALIDATION_MANAGER, shared_1.SystemRole.VALIDATOR, shared_1.SystemRole.DATA_ENTRY_HEAD, shared_1.SystemRole.READ_ONLY_AUDITOR),
    (0, swagger_1.ApiOperation)({ summary: 'Get document statistics' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "getStats", null);
__decorate([
    (0, common_1.Get)('queue/data-entry'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DATA_ENTRY_HEAD),
    (0, swagger_1.ApiOperation)({ summary: 'Get data entry queue — all received PDFs grouped by assessment' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "getDataEntryQueue", null);
__decorate([
    (0, common_1.Post)(':id/send-external-ocr'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DATA_ENTRY_HEAD),
    (0, swagger_1.ApiOperation)({ summary: 'Mark an audited PDF as sent to External OCR application' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "sendToExternalOcr", null);
__decorate([
    (0, common_1.Post)('upload-excel'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DATA_ENTRY_HEAD),
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
__decorate([
    (0, common_1.Get)('data-entry/queue'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DATA_ENTRY_HEAD, shared_1.SystemRole.DOCUMENT_EXECUTIVE, shared_1.SystemRole.VALIDATION_MANAGER, shared_1.SystemRole.VALIDATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.READ_ONLY_AUDITOR),
    (0, swagger_1.ApiOperation)({ summary: "Returned packets at the data entry desk and who owns each" }),
    __param(0, (0, common_1.Query)('assignedTo')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "dataEntryQueue", null);
__decorate([
    (0, common_1.Get)('data-entry/mine'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DATA_ENTRY_HEAD, shared_1.SystemRole.DOCUMENT_EXECUTIVE, shared_1.SystemRole.VALIDATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Packets delegated to the signed-in team member' }),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "myDataEntryQueue", null);
__decorate([
    (0, common_1.Get)('data-entry/team'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DATA_ENTRY_HEAD),
    (0, swagger_1.ApiOperation)({ summary: 'People a returned packet can be delegated to' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "dataEntryTeam", null);
__decorate([
    (0, common_1.Post)(':id/assign-data-entry'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DATA_ENTRY_HEAD),
    (0, swagger_1.ApiOperation)({ summary: 'Delegate a returned packet to a data entry team member' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "assignDataEntry", null);
__decorate([
    (0, common_1.Post)(':id/complete-data-entry'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.DATA_ENTRY_HEAD, shared_1.SystemRole.DOCUMENT_EXECUTIVE, shared_1.SystemRole.VALIDATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Hand a processed packet back to the data entry head' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], DocumentController.prototype, "completeDataEntry", null);
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
        typeorm_2.Repository,
        validation_service_1.ValidationService,
        assignment_service_1.AssignmentService,
        document_access_token_service_1.DocumentAccessTokenService,
        chunked_upload_service_1.ChunkedUploadService])
], DocumentController);
//# sourceMappingURL=document.controller.js.map
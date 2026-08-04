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
var DocumentService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const validation_service_1 = require("../validation/validation.service");
const typeorm_2 = require("typeorm");
const document_entity_1 = require("./document.entity");
const assessment_entity_1 = require("../project/assessment.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
const notification_service_1 = require("../notifications/notification.service");
const push_notification_service_1 = require("../notifications/push-notification.service");
const local_storage_service_1 = require("../../infrastructure/storage/local-storage.service");
const shared_1 = require("@fapoms/shared");
let DocumentService = class DocumentService {
    static { DocumentService_1 = this; }
    documentRepository;
    assessmentRepository;
    projectBranchRepository;
    assignmentRepository;
    auditService;
    eventPublisher;
    notificationService;
    pushNotificationService;
    localStorageService;
    validationService;
    logger = new common_1.Logger(DocumentService_1.name);
    async dataEntryQueue(assignedTo) {
        const qb = this.documentRepository
            .createQueryBuilder('d')
            .leftJoin('project_branches', 'pb', 'pb.id = d.project_branch_id')
            .leftJoin('branches', 'b', 'b.id = pb.branch_id')
            .leftJoin('users', 'u', 'u.id = d.assigned_to_user_id')
            .select([
            'd.id AS id', 'd.file_name AS "fileName"', 'd.status AS status',
            'd.received_at AS "receivedAt"', 'd.sent_to_data_entry_at AS "sentToDataEntryAt"',
            'd.assigned_to_user_id AS "assignedToUserId"', 'd.assigned_at AS "assignedAt"',
            'd.data_entry_completed_at AS "completedAt"',
            'd.project_branch_id AS "projectBranchId"',
            'b.name AS "branchName"', 'b.branch_code AS "branchCode"',
            `COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.username) AS "assigneeName"`,
        ])
            .where('d.is_active = true')
            .andWhere('d.type = :type', { type: shared_1.DocumentType.AUDITED_RETURN_PDF })
            .andWhere('d.status IN (:...statuses)', {
            statuses: [shared_1.DocumentStatus.RECEIVED, shared_1.DocumentStatus.SENT_TO_DATA_ENTRY, shared_1.DocumentStatus.SENT_TO_EXTERNAL_OCR],
        });
        if (assignedTo === 'unassigned')
            qb.andWhere('d.assigned_to_user_id IS NULL');
        else if (assignedTo)
            qb.andWhere('d.assigned_to_user_id = :uid', { uid: assignedTo });
        const rows = await qb.orderBy('d.received_at', 'ASC', 'NULLS LAST').getRawMany();
        return {
            total: rows.length,
            unassigned: rows.filter((r) => !r.assignedToUserId).length,
            inProgress: rows.filter((r) => r.assignedToUserId && !r.completedAt).length,
            completed: rows.filter((r) => r.completedAt).length,
            items: rows,
        };
    }
    async dataEntryTeam() {
        return this.documentRepository.manager.query(`
      SELECT DISTINCT u.id,
             COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.username) AS name,
             u.username, r.name AS role
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active = true
        AND r.name IN ('DATA_ENTRY_HEAD', 'DOCUMENT_EXECUTIVE', 'VALIDATOR')
      ORDER BY name
    `);
    }
    async assignForDataEntry(documentId, assigneeId, actorId) {
        const doc = await this.findOne(documentId);
        if (doc.type !== shared_1.DocumentType.AUDITED_RETURN_PDF) {
            throw new common_1.BadRequestException('Only returned audit packets are delegated to data entry.');
        }
        doc.assignedToUserId = assigneeId;
        doc.assignedAt = new Date();
        doc.assignedBy = actorId;
        doc.dataEntryCompletedAt = null;
        if (doc.status === shared_1.DocumentStatus.RECEIVED) {
            doc.status = shared_1.DocumentStatus.SENT_TO_DATA_ENTRY;
            doc.sentToDataEntryAt = doc.sentToDataEntryAt ?? new Date();
        }
        doc.updatedBy = actorId;
        const saved = await this.documentRepository.save(doc);
        if (doc.projectBranchId) {
            try {
                await this.validationService.getOrCreateForBranch(doc.projectBranchId, doc.assessmentId ?? null, actorId);
            }
            catch (e) {
                this.logger.warn(`Could not open validation case for branch ${doc.projectBranchId}: ${e.message}`);
            }
        }
        return saved;
    }
    async completeDataEntry(documentId, actorId) {
        const doc = await this.findOne(documentId);
        if (!doc.assignedToUserId) {
            throw new common_1.BadRequestException('This packet has not been delegated to anyone.');
        }
        doc.dataEntryCompletedAt = new Date();
        doc.updatedBy = actorId;
        const saved = await this.documentRepository.save(doc);
        if (doc.projectBranchId) {
            try {
                await this.validationService.getOrAdvanceForHandBack(doc.projectBranchId, doc.assessmentId ?? null, actorId);
            }
            catch (e) {
                this.logger.warn(`Could not advance validation case for branch ${doc.projectBranchId}: ${e.message}`);
            }
        }
        return saved;
    }
    constructor(documentRepository, assessmentRepository, projectBranchRepository, assignmentRepository, auditService, eventPublisher, notificationService, pushNotificationService, localStorageService, validationService) {
        this.documentRepository = documentRepository;
        this.assessmentRepository = assessmentRepository;
        this.projectBranchRepository = projectBranchRepository;
        this.assignmentRepository = assignmentRepository;
        this.auditService = auditService;
        this.eventPublisher = eventPublisher;
        this.notificationService = notificationService;
        this.pushNotificationService = pushNotificationService;
        this.localStorageService = localStorageService;
        this.validationService = validationService;
    }
    async create(dto, userId) {
        let assessment = await this.assessmentRepository.findOne({
            where: { id: dto.assessmentId, isActive: true },
        }).catch(() => null);
        let pb = null;
        if (!assessment) {
            pb = await this.projectBranchRepository.findOne({ where: { id: dto.assessmentId } }).catch(() => null);
            if (!pb) {
                const asn = await this.assignmentRepository.findOne({ where: { id: dto.assessmentId } }).catch(() => null);
                if (asn?.projectBranchId) {
                    pb = await this.projectBranchRepository.findOne({ where: { id: asn.projectBranchId } }).catch(() => null);
                }
            }
            if (pb) {
                assessment = await this.assessmentRepository.findOne({
                    where: { projectId: pb.projectId, branchId: pb.branchId, isActive: true },
                }).catch(() => null);
                if (!assessment) {
                    assessment = await this.assessmentRepository.save(this.assessmentRepository.create({
                        projectId: pb.projectId,
                        branchId: pb.branchId,
                        status: shared_1.AssessmentStatus.PENDING_PLANNING,
                        createdBy: userId,
                        updatedBy: userId,
                    }));
                }
            }
        }
        if (!assessment) {
            throw new common_1.NotFoundException(`Assessment, ProjectBranch or Assignment ${dto.assessmentId} not found.`);
        }
        if (!pb) {
            pb = await this.projectBranchRepository
                .findOne({ where: { projectId: assessment.projectId, branchId: assessment.branchId } })
                .catch(() => null);
        }
        const doc = this.documentRepository.create({
            assessmentId: assessment.id,
            projectBranchId: pb?.id ?? null,
            fileName: dto.fileName,
            filePath: dto.filePath,
            fileSize: dto.fileSize,
            mimeType: dto.mimeType ?? null,
            type: dto.type,
            customerMasterVersionId: dto.customerMasterVersionId ?? null,
            status: shared_1.DocumentStatus.UPLOADED,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.documentRepository.save(doc);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'DOCUMENT_UPLOADED',
            entityType: 'DOCUMENT',
            entityId: saved.id,
            userId,
            remarks: `Uploaded document ${dto.fileName} for assessment.`,
        });
        try {
            this.eventPublisher.publish('document:uploaded', {
                eventType: 'document:uploaded',
                documentId: saved.id,
                assessmentId: saved.assessmentId,
                fileName: saved.fileName,
                fileSize: saved.fileSize,
                type: saved.type,
                userId,
                timestamp: new Date(),
            });
        }
        catch (err) {
            console.error('Failed to publish document:uploaded event:', err);
        }
        await this.syncAssessmentFromDocument(saved, userId);
        return saved;
    }
    async findOne(id) {
        const doc = await this.documentRepository.findOne({
            where: { id, isActive: true },
            relations: ['assessment', 'assessment.branch', 'assessment.project'],
        });
        if (!doc) {
            throw new common_1.NotFoundException(`Document ${id} not found.`);
        }
        return doc;
    }
    async updateStatus(id, status, userId) {
        const doc = await this.findOne(id);
        const prevStatus = doc.status;
        doc.status = status;
        doc.updatedBy = userId;
        const saved = await this.documentRepository.save(doc);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: `DOCUMENT_${status}`,
            entityType: 'DOCUMENT',
            entityId: saved.id,
            previousState: prevStatus,
            newState: status,
            userId,
            remarks: `Transitioned document ${doc.fileName} to ${status}.`,
        });
        try {
            this.eventPublisher.publish('document:status-changed', {
                eventType: 'document:status-changed',
                documentId: saved.id,
                assessmentId: saved.assessmentId,
                fileName: saved.fileName,
                previousStatus: prevStatus,
                newStatus: status,
                userId,
                timestamp: new Date(),
            });
        }
        catch (err) {
            console.error('Failed to publish document:status-changed event:', err);
        }
        return saved;
    }
    async operationsOverview(filters = {}) {
        const where = ['d.is_active = true'];
        const params = [];
        if (filters.projectId) {
            params.push(filters.projectId);
            where.push(`a.project_id = $${params.length}`);
        }
        if (filters.status) {
            params.push(filters.status);
            where.push(`d.status = $${params.length}`);
        }
        if (filters.type) {
            params.push(filters.type);
            where.push(`d.type = $${params.length}`);
        }
        const rows = await this.documentRepository.manager.query(`SELECT d.id, d.file_name, d.file_size, d.type, d.status, d.doc_version,
              d.created_at, d.dispatched_at, d.dispatch_method, d.dispatched_by,
              d.received_at, d.sent_to_data_entry_at, d.sent_to_external_ocr_at,
              d.assessment_id,
              b.name AS branch_name, b.branch_code,
              p.name AS project_name, p.project_number,
              c.name AS client_name,
              pb.id AS project_branch_id, pb.scheduled_date,
              u.display_name AS dispatched_by_name
         FROM documents d
         LEFT JOIN assessments a  ON a.id = d.assessment_id
         LEFT JOIN branches b     ON b.id = a.branch_id
         LEFT JOIN projects p     ON p.id = a.project_id
         LEFT JOIN clients c      ON c.id = p.client_id
         LEFT JOIN project_branches pb ON pb.project_id = a.project_id AND pb.branch_id = a.branch_id
         LEFT JOIN users u        ON u.id = d.dispatched_by
        WHERE ${where.join(' AND ')}
        ORDER BY d.created_at DESC`, params);
        const documents = rows.map((r) => ({
            id: r.id,
            fileName: r.file_name,
            fileSize: Number(r.file_size ?? 0),
            type: r.type,
            status: r.status,
            version: r.doc_version,
            createdAt: r.created_at,
            projectBranchId: r.project_branch_id,
            assessmentId: r.assessment_id,
            branchName: r.branch_name,
            branchCode: r.branch_code,
            projectName: r.project_name,
            projectNumber: r.project_number,
            clientName: r.client_name,
            scheduledDate: r.scheduled_date,
            trail: {
                uploadedAt: r.created_at,
                dispatchedAt: r.dispatched_at,
                dispatchMethod: r.dispatch_method,
                dispatchedByName: r.dispatched_by_name,
                receivedAt: r.received_at,
                sentToDataEntryAt: r.sent_to_data_entry_at,
                sentToExternalOcrAt: r.sent_to_external_ocr_at,
            },
        }));
        const stageOrder = [
            shared_1.DocumentStatus.UPLOADED, shared_1.DocumentStatus.DISPATCHED, shared_1.DocumentStatus.RECEIVED,
            shared_1.DocumentStatus.SENT_TO_DATA_ENTRY, shared_1.DocumentStatus.SENT_TO_EXTERNAL_OCR,
            shared_1.DocumentStatus.EXCEL_GENERATED, shared_1.DocumentStatus.PROCESSED, shared_1.DocumentStatus.COMPLETED,
        ];
        const pipeline = stageOrder.map((stage) => ({
            stage,
            count: documents.filter((d) => d.status === stage).length,
        }));
        const today = new Date().toISOString().slice(0, 10);
        const awaitingDispatch = documents
            .filter((d) => d.status === shared_1.DocumentStatus.UPLOADED
            && DocumentService_1.ASSAYER_VISIBLE_TYPES.includes(d.type))
            .map((d) => ({
            ...d,
            daysUntilAudit: d.scheduledDate
                ? Math.round((new Date(d.scheduledDate).getTime() - new Date(today).getTime()) / 86400000)
                : null,
        }))
            .sort((a, b) => (a.daysUntilAudit ?? 9999) - (b.daysUntilAudit ?? 9999));
        const branchWhere = ['pb.is_active = true'];
        const branchParams = [];
        if (filters.projectId) {
            branchParams.push(filters.projectId);
            branchWhere.push(`pb.project_id = $${branchParams.length}`);
        }
        const branchRows = await this.documentRepository.manager.query(`SELECT pb.id AS project_branch_id, pb.status AS pb_status, pb.scheduled_date,
              b.id AS branch_id, b.name AS branch_name, b.branch_code,
              p.id AS project_id, p.name AS project_name, p.project_number,
              c.name AS client_name,
              a.status AS assessment_status
         FROM project_branches pb
         JOIN branches b ON b.id = pb.branch_id
         JOIN projects p ON p.id = pb.project_id
         LEFT JOIN clients c ON c.id = p.client_id
         LEFT JOIN assessments a ON a.project_id = pb.project_id AND a.branch_id = pb.branch_id AND a.is_active = true
        WHERE ${branchWhere.join(' AND ')}
        ORDER BY b.name`, branchParams);
        const docsByBranch = new Map();
        for (const d of documents) {
            if (!d.projectBranchId)
                continue;
            if (!docsByBranch.has(d.projectBranchId))
                docsByBranch.set(d.projectBranchId, []);
            docsByBranch.get(d.projectBranchId).push(d);
        }
        const branches = branchRows.map((r) => {
            const docs = docsByBranch.get(r.project_branch_id) ?? [];
            const documentsByType = {};
            for (const d of docs) {
                (documentsByType[d.type] ??= []).push(d);
            }
            const daysUntilAudit = r.scheduled_date
                ? Math.round((new Date(r.scheduled_date).getTime() - new Date(today).getTime()) / 86400000)
                : null;
            return {
                projectBranchId: r.project_branch_id,
                branchId: r.branch_id,
                branchName: r.branch_name,
                branchCode: r.branch_code,
                projectId: r.project_id,
                projectName: r.project_name,
                projectNumber: r.project_number,
                clientName: r.client_name,
                branchStatus: r.pb_status,
                assessmentStatus: r.assessment_status,
                scheduledDate: r.scheduled_date,
                daysUntilAudit,
                documentCount: docs.length,
                documentsByType,
            };
        });
        const neverPrepared = branches
            .filter((br) => br.scheduledDate
            && ['ASSIGNMENT_CONFIRMED', 'SCHEDULED'].includes(br.branchStatus)
            && !br.documentsByType[shared_1.DocumentType.PRE_FIELD_AUDIT_PDF]?.length)
            .sort((a, b) => (a.daysUntilAudit ?? 9999) - (b.daysUntilAudit ?? 9999));
        return {
            documents,
            pipeline,
            branches,
            totals: {
                total: documents.length,
                awaitingDispatch: awaitingDispatch.length,
                neverPrepared: neverPrepared.length,
                outstandingReturns: documents.filter((d) => d.status === shared_1.DocumentStatus.DISPATCHED && d.type === shared_1.DocumentType.PRE_FIELD_AUDIT_PDF).length,
                inDataEntry: documents.filter((d) => d.status === shared_1.DocumentStatus.SENT_TO_DATA_ENTRY).length,
                completed: documents.filter((d) => d.status === shared_1.DocumentStatus.COMPLETED).length,
            },
            awaitingDispatch,
            neverPrepared,
            blockingFieldWork: awaitingDispatch.filter((d) => d.daysUntilAudit !== null && d.daysUntilAudit <= 1),
        };
    }
    async matchPdfsToBranches(projectId, auditDate, fileNames) {
        const branches = await this.documentRepository.manager.query(`SELECT pb.id AS project_branch_id, b.name AS branch_name, b.branch_code
           FROM project_branches pb
           JOIN branches b ON b.id = pb.branch_id
          WHERE pb.project_id = $1 AND pb.is_active = true AND pb.scheduled_date = $2`, [projectId, auditDate]);
        const norm = (v) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
        const matches = [];
        const unmatched = [];
        const claimed = new Set();
        for (const fileName of fileNames) {
            const haystack = norm(fileName);
            let candidates = branches.filter((b) => b.branch_code && haystack.includes(norm(b.branch_code)));
            let matchedOn = 'CODE';
            if (candidates.length === 0) {
                candidates = branches.filter((b) => b.branch_name
                    .split(/\s+/)
                    .map((w) => norm(w))
                    .filter((w) => w.length >= 4 && w !== 'branch')
                    .some((w) => haystack.includes(w)));
                matchedOn = 'NAME';
            }
            if (candidates.length === 0) {
                unmatched.push({ fileName, reason: 'No scheduled branch matches this filename.' });
                continue;
            }
            if (candidates.length > 1) {
                unmatched.push({
                    fileName,
                    reason: `Matches ${candidates.length} branches (${candidates.map((c) => c.branch_name).join(', ')}) — assign manually.`,
                });
                continue;
            }
            const branch = candidates[0];
            if (claimed.has(branch.project_branch_id)) {
                unmatched.push({ fileName, reason: `Another file in this upload already matched ${branch.branch_name}.` });
                continue;
            }
            claimed.add(branch.project_branch_id);
            matches.push({
                fileName,
                projectBranchId: branch.project_branch_id,
                branchName: branch.branch_name,
                branchCode: branch.branch_code,
                matchedOn,
            });
        }
        return {
            matches,
            unmatched,
            branchesWithoutFile: branches
                .filter((b) => !claimed.has(b.project_branch_id))
                .map((b) => ({ projectBranchId: b.project_branch_id, branchName: b.branch_name, branchCode: b.branch_code })),
        };
    }
    async dispatchMany(documentIds, userId) {
        const dispatched = [];
        const failed = [];
        for (const id of documentIds) {
            try {
                await this.dispatchDocument(id, userId, shared_1.DispatchMethod.MANUAL);
                dispatched.push(id);
            }
            catch (err) {
                failed.push({ documentId: id, reason: err.message });
            }
        }
        return { dispatched, failed };
    }
    static ASSAYER_VISIBLE_TYPES = [
        shared_1.DocumentType.PRE_FIELD_AUDIT_PDF,
    ];
    static DISPATCHED_STATUSES = [
        shared_1.DocumentStatus.DISPATCHED,
        shared_1.DocumentStatus.RECEIVED,
        shared_1.DocumentStatus.SENT_TO_DATA_ENTRY,
        shared_1.DocumentStatus.SENT_TO_EXTERNAL_OCR,
        shared_1.DocumentStatus.EXCEL_GENERATED,
        shared_1.DocumentStatus.PROCESSED,
        shared_1.DocumentStatus.COMPLETED,
    ];
    async findDispatchedForAssayer(projectBranchId) {
        const all = await this.findByProjectBranch(projectBranchId);
        const relevant = all.filter((d) => DocumentService_1.ASSAYER_VISIBLE_TYPES.includes(d.type));
        const documents = relevant.filter((d) => DocumentService_1.DISPATCHED_STATUSES.includes(d.status));
        const awaiting = relevant.filter((d) => d.status === shared_1.DocumentStatus.UPLOADED);
        const lastDispatchedAt = documents
            .map((d) => d.dispatchedAt)
            .filter((v) => !!v)
            .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        let state = 'NONE';
        let message = 'No audit paperwork has been prepared for this branch yet. You will be notified when it is sent.';
        if (documents.length > 0) {
            state = 'READY';
            message = `${documents.length} document${documents.length === 1 ? '' : 's'} ready to download.`;
        }
        else if (awaiting.length > 0) {
            state = 'PREPARING';
            message = 'Your paperwork is prepared and will be sent by operations shortly. You will be notified the moment it is released.';
        }
        return {
            documents,
            readiness: {
                state,
                dispatchedCount: documents.length,
                awaitingDispatchCount: awaiting.length,
                message,
                lastDispatchedAt,
            },
        };
    }
    async assertAssayerMayDownload(documentId, assayerId) {
        const doc = await this.findOne(documentId);
        if (!DocumentService_1.ASSAYER_VISIBLE_TYPES.includes(doc.type)) {
            throw new common_1.BadRequestException('This document type is not available to field assayers.');
        }
        if (!DocumentService_1.DISPATCHED_STATUSES.includes(doc.status)) {
            throw new common_1.BadRequestException('This document has not been dispatched yet. It will become available once operations releases it.');
        }
        const assessment = doc.assessmentId
            ? await this.assessmentRepository.findOne({ where: { id: doc.assessmentId } }).catch(() => null)
            : null;
        if (!assessment)
            return;
        const linked = await this.assignmentRepository
            .createQueryBuilder('a')
            .innerJoin('project_branches', 'pb', 'pb.id = a.project_branch_id')
            .where('a.assayer_id = :assayerId', { assayerId })
            .andWhere('a.is_active = true')
            .andWhere('pb.project_id = :projectId', { projectId: assessment.projectId })
            .andWhere('pb.branch_id = :branchId', { branchId: assessment.branchId })
            .getCount();
        if (linked === 0) {
            throw new common_1.BadRequestException('You are not assigned to the branch this document belongs to.');
        }
    }
    async findByProjectBranch(projectBranchId) {
        const pb = await this.projectBranchRepository.findOne({ where: { id: projectBranchId } }).catch(() => null);
        if (!pb)
            return [];
        const assessment = await this.assessmentRepository.findOne({
            where: { projectId: pb.projectId, branchId: pb.branchId, isActive: true },
        }).catch(() => null);
        if (!assessment)
            return [];
        return this.documentRepository.find({
            where: { assessmentId: assessment.id, isActive: true },
            order: { createdAt: 'DESC' },
        });
    }
    async findByAssessment(assessmentId) {
        return this.documentRepository.find({
            where: { assessmentId, isActive: true },
            order: { createdAt: 'DESC' },
        });
    }
    async findByProject(projectId) {
        const assessmentIds = await this.assessmentRepository.find({
            where: { projectId, isActive: true },
            select: ['id'],
        });
        return this.documentRepository.find({
            where: { assessmentId: assessmentIds.length > 0 ? assessmentIds.map(a => a.id) : undefined, isActive: true },
            relations: ['assessment', 'assessment.branch'],
            order: { createdAt: 'DESC' },
        });
    }
    async dispatchDocument(id, userId, method = shared_1.DispatchMethod.MANUAL) {
        const doc = await this.findOne(id);
        if (doc.status !== shared_1.DocumentStatus.UPLOADED) {
            throw new common_1.BadRequestException(`Document ${id} cannot be dispatched from status ${doc.status} — only UPLOADED documents can be dispatched.`);
        }
        const saved = await this.updateStatus(id, shared_1.DocumentStatus.DISPATCHED, userId);
        saved.dispatchedAt = new Date();
        saved.dispatchMethod = method;
        saved.dispatchedBy = userId === 'SYSTEM' ? null : userId;
        await this.documentRepository.save(saved);
        await this.syncAssessmentFromDocument(saved, userId);
        if (!doc.assessmentId) {
            this.logger.warn(`Document ${id} dispatched but has no assessmentId — the assayer cannot be resolved or notified.`);
            return saved;
        }
        const assignment = await this.assignmentRepository.findOne({
            where: { assessmentId: doc.assessmentId, isActive: true },
            relations: ['assayer'],
        });
        if (!assignment) {
            this.logger.warn(`Document ${id} dispatched for assessment ${doc.assessmentId} but no active assignment links to it — no assayer was notified.`);
        }
        if (assignment?.assayer) {
            try {
                const { inAppDelivered } = await this.notificationService.notifyAssayer(assignment.assayerId, assignment.assayer.email, {
                    title: 'New Audit PDF',
                    message: `Audit PDF "${doc.fileName}" has been dispatched to you. Open your schedule to view and download.`,
                    link: `/assignments/${assignment.id}`,
                    data: { documentId: doc.id, assignmentId: assignment.id, type: 'document_dispatched' },
                }, userId);
                if (!inAppDelivered) {
                    this.logger.warn(`Document ${id} dispatched to assayer ${assignment.assayerId} but no matching user account was found for "${assignment.assayer.email}" — in-app notification not created.`);
                }
            }
            catch (err) {
                this.logger.error(`Failed to send dispatch notification for document ${id}:`, err);
            }
        }
        return saved;
    }
    async receiveDocument(id, userId) {
        const doc = await this.findOne(id);
        const isAssayerReturn = doc.type === shared_1.DocumentType.AUDITED_RETURN_PDF;
        const allowed = isAssayerReturn
            ? [shared_1.DocumentStatus.UPLOADED, shared_1.DocumentStatus.DISPATCHED]
            : [shared_1.DocumentStatus.DISPATCHED];
        if (!allowed.includes(doc.status)) {
            throw new common_1.BadRequestException(`Document ${id} cannot be received from status ${doc.status} (expected one of ${allowed.join(', ')}).`);
        }
        const saved = await this.updateStatus(id, shared_1.DocumentStatus.RECEIVED, userId);
        saved.receivedAt = new Date();
        await this.documentRepository.save(saved);
        await this.syncAssessmentFromDocument(saved, userId);
        try {
            this.eventPublisher.publish('document:received', {
                eventType: 'document:received',
                documentId: saved.id,
                assessmentId: saved.assessmentId,
                fileName: saved.fileName,
                userId,
                timestamp: new Date(),
            });
        }
        catch (err) {
            console.error('Failed to publish document:received event:', err);
        }
        return saved;
    }
    static PIPELINE_ORDER = [
        shared_1.AssessmentStatus.PENDING_PLANNING,
        shared_1.AssessmentStatus.ASSESSOR_RECOMMENDED,
        shared_1.AssessmentStatus.IN_NEGOTIATION,
        shared_1.AssessmentStatus.ASSIGNED_AND_SCHEDULED,
        shared_1.AssessmentStatus.AWAITING_CLIENT_DATA,
        shared_1.AssessmentStatus.CLIENT_DATA_RECEIVED,
        shared_1.AssessmentStatus.PDF_GENERATED,
        shared_1.AssessmentStatus.READY_FOR_DISPATCH,
        shared_1.AssessmentStatus.DISPATCHED_TO_ASSESSOR,
        shared_1.AssessmentStatus.AUDITED_PDF_RECEIVED,
        shared_1.AssessmentStatus.SENT_TO_DATA_ENTRY,
        shared_1.AssessmentStatus.DATA_ENTRY_IN_PROGRESS,
        shared_1.AssessmentStatus.REPORT_FINALIZED,
        shared_1.AssessmentStatus.PENDING_HEAD_APPROVAL,
        shared_1.AssessmentStatus.DELIVERED_TO_CLIENT,
        shared_1.AssessmentStatus.COMPLETED,
    ];
    static DOCUMENT_TO_ASSESSMENT = {
        [shared_1.DocumentStatus.UPLOADED]: shared_1.AssessmentStatus.READY_FOR_DISPATCH,
        [shared_1.DocumentStatus.DISPATCHED]: shared_1.AssessmentStatus.DISPATCHED_TO_ASSESSOR,
        [shared_1.DocumentStatus.RECEIVED]: shared_1.AssessmentStatus.AUDITED_PDF_RECEIVED,
        [shared_1.DocumentStatus.SENT_TO_DATA_ENTRY]: shared_1.AssessmentStatus.SENT_TO_DATA_ENTRY,
        [shared_1.DocumentStatus.SENT_TO_EXTERNAL_OCR]: shared_1.AssessmentStatus.DATA_ENTRY_IN_PROGRESS,
        [shared_1.DocumentStatus.EXCEL_GENERATED]: shared_1.AssessmentStatus.REPORT_FINALIZED,
        [shared_1.DocumentStatus.COMPLETED]: shared_1.AssessmentStatus.DELIVERED_TO_CLIENT,
    };
    async syncAssessmentFromDocument(doc, userId) {
        if (!doc.assessmentId)
            return;
        const drivesPipeline = doc.type === shared_1.DocumentType.PRE_FIELD_AUDIT_PDF || doc.type === shared_1.DocumentType.AUDITED_RETURN_PDF;
        if (!drivesPipeline)
            return;
        const target = DocumentService_1.DOCUMENT_TO_ASSESSMENT[doc.status];
        if (!target)
            return;
        const assessment = await this.assessmentRepository
            .findOne({ where: { id: doc.assessmentId, isActive: true } })
            .catch(() => null);
        if (!assessment)
            return;
        const currentIdx = DocumentService_1.PIPELINE_ORDER.indexOf(assessment.status);
        const targetIdx = DocumentService_1.PIPELINE_ORDER.indexOf(target);
        if (targetIdx === -1 || currentIdx === -1 || targetIdx <= currentIdx)
            return;
        const previous = assessment.status;
        assessment.status = target;
        assessment.updatedBy = userId;
        await this.assessmentRepository.save(assessment);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.WORKFLOW,
            eventType: 'ASSESSMENT_PIPELINE_ADVANCED',
            entityType: 'ASSESSMENT',
            entityId: assessment.id,
            previousState: previous,
            newState: target,
            userId,
            remarks: `Advanced by document "${doc.fileName}" (${doc.type} → ${doc.status}).`,
        });
        try {
            this.eventPublisher.publish('assessment:status-changed', {
                eventType: 'assessment:status-changed',
                assessmentId: assessment.id,
                previousStatus: previous,
                status: target,
                documentId: doc.id,
                userId,
                timestamp: new Date(),
            });
        }
        catch (err) {
            this.logger.error('Failed to publish assessment:status-changed event:', err?.message);
        }
    }
    async findDataEntryQueue() {
        const docs = await this.documentRepository.find({
            where: {
                type: shared_1.DocumentType.AUDITED_RETURN_PDF,
                isActive: true,
                status: (0, typeorm_2.In)([
                    shared_1.DocumentStatus.RECEIVED,
                    shared_1.DocumentStatus.SENT_TO_DATA_ENTRY,
                    shared_1.DocumentStatus.SENT_TO_EXTERNAL_OCR,
                    shared_1.DocumentStatus.EXCEL_GENERATED,
                ]),
            },
            relations: ['assessment', 'assessment.branch', 'assessment.project'],
            order: { receivedAt: 'ASC', createdAt: 'ASC' },
        });
        const assessmentIds = [...new Set(docs.map((d) => d.assessmentId).filter(Boolean))];
        const assignments = assessmentIds.length
            ? await this.assignmentRepository.find({
                where: { assessmentId: (0, typeorm_2.In)(assessmentIds), isActive: true },
                relations: ['assayer'],
            })
            : [];
        const assayerByAssessment = new Map(assignments.map((a) => [a.assessmentId, a.assayer?.displayName ?? null]));
        const now = Date.now();
        const grouped = new Map();
        for (const doc of docs) {
            const key = doc.assessmentId || 'unknown';
            if (!grouped.has(key)) {
                const since = doc.receivedAt ?? doc.createdAt;
                grouped.set(key, {
                    assessmentId: key,
                    project: doc.assessment?.project?.name || 'Unknown',
                    branch: doc.assessment?.branch?.name || 'Unknown',
                    assayer: assayerByAssessment.get(key) ?? null,
                    receivedAt: doc.receivedAt ?? null,
                    daysPending: since ? Math.floor((now - new Date(since).getTime()) / 86_400_000) : null,
                    status: doc.status,
                    documents: [],
                });
            }
            grouped.get(key).documents.push(doc);
        }
        return Array.from(grouped.values());
    }
    async markSentToExternalOcr(id, userId) {
        const doc = await this.findOne(id);
        if (doc.status !== shared_1.DocumentStatus.RECEIVED && doc.status !== shared_1.DocumentStatus.SENT_TO_DATA_ENTRY) {
            throw new common_1.BadRequestException(`Document ${id} cannot be sent to external OCR from status ${doc.status}.`);
        }
        const saved = await this.updateStatus(id, shared_1.DocumentStatus.SENT_TO_EXTERNAL_OCR, userId);
        saved.sentToExternalOcrAt = new Date();
        if (!saved.sentToDataEntryAt)
            saved.sentToDataEntryAt = new Date();
        await this.documentRepository.save(saved);
        await this.syncAssessmentFromDocument(saved, userId);
        return saved;
    }
    buildTransportTrail(doc) {
        const stages = [
            { stage: 'Uploaded', at: doc.createdAt ?? null, by: doc.createdBy ?? null, method: null },
            { stage: 'Dispatched to Assayer', at: doc.dispatchedAt, by: doc.dispatchedBy, method: doc.dispatchMethod },
            { stage: 'Received from Assayer', at: doc.receivedAt, by: null, method: null },
            { stage: 'Sent to Data Entry', at: doc.sentToDataEntryAt, by: null, method: null },
            { stage: 'Sent to External OCR', at: doc.sentToExternalOcrAt, by: null, method: null },
        ];
        return stages.map((s) => ({ ...s, done: s.at != null }));
    }
    async findAll() {
        return this.documentRepository.find({
            where: { isActive: true },
            relations: ['assessment', 'assessment.branch', 'assessment.project'],
            order: { createdAt: 'DESC' },
        });
    }
    async getDocumentStats() {
        const all = await this.documentRepository.find({ where: { isActive: true } });
        return {
            total: all.length,
            uploaded: all.filter(d => d.status === shared_1.DocumentStatus.UPLOADED).length,
            dispatched: all.filter(d => d.status === shared_1.DocumentStatus.DISPATCHED).length,
            received: all.filter(d => d.status === shared_1.DocumentStatus.RECEIVED).length,
        };
    }
};
exports.DocumentService = DocumentService;
exports.DocumentService = DocumentService = DocumentService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(document_entity_1.DocumentEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(assessment_entity_1.AssessmentEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(project_branch_entity_1.ProjectBranchEntity)),
    __param(3, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        audit_service_1.AuditService,
        domain_event_publisher_1.DomainEventPublisher,
        notification_service_1.NotificationService,
        push_notification_service_1.PushNotificationService,
        local_storage_service_1.LocalStorageService,
        validation_service_1.ValidationService])
], DocumentService);
//# sourceMappingURL=document.service.js.map
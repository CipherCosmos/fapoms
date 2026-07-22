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
exports.AssayerService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const assayer_entity_1 = require("./assayer.entity");
const assayer_commercial_profile_entity_1 = require("./assayer-commercial-profile.entity");
const workforce_attribute_entity_1 = require("./workforce-attribute.entity");
const assayer_government_document_entity_1 = require("./assayer-government-document.entity");
const assayer_document_entity_1 = require("./assayer-document.entity");
const assayer_remark_entity_1 = require("./assayer-remark.entity");
const assayer_activity_entity_1 = require("./assayer-activity.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
const LIFECYCLE_TRANSITIONS = {
    [shared_1.AssayerLifecycleStatus.INVITED]: [shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION],
    [shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: [shared_1.AssayerLifecycleStatus.BACKGROUND_VERIFICATION, shared_1.AssayerLifecycleStatus.INACTIVE],
    [shared_1.AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: [shared_1.AssayerLifecycleStatus.TRAINING, shared_1.AssayerLifecycleStatus.INACTIVE],
    [shared_1.AssayerLifecycleStatus.TRAINING]: [shared_1.AssayerLifecycleStatus.ACTIVE, shared_1.AssayerLifecycleStatus.INACTIVE],
    [shared_1.AssayerLifecycleStatus.ACTIVE]: [shared_1.AssayerLifecycleStatus.ON_LEAVE, shared_1.AssayerLifecycleStatus.SUSPENDED, shared_1.AssayerLifecycleStatus.INACTIVE, shared_1.AssayerLifecycleStatus.RESIGNED],
    [shared_1.AssayerLifecycleStatus.ON_LEAVE]: [shared_1.AssayerLifecycleStatus.ACTIVE, shared_1.AssayerLifecycleStatus.INACTIVE],
    [shared_1.AssayerLifecycleStatus.SUSPENDED]: [shared_1.AssayerLifecycleStatus.ACTIVE, shared_1.AssayerLifecycleStatus.TERMINATED],
    [shared_1.AssayerLifecycleStatus.INACTIVE]: [shared_1.AssayerLifecycleStatus.ACTIVE, shared_1.AssayerLifecycleStatus.ARCHIVED],
    [shared_1.AssayerLifecycleStatus.RESIGNED]: [shared_1.AssayerLifecycleStatus.ARCHIVED],
    [shared_1.AssayerLifecycleStatus.TERMINATED]: [shared_1.AssayerLifecycleStatus.ARCHIVED],
};
function mapLifecycleToOperationalStatus(lifecycle) {
    if (lifecycle === shared_1.AssayerLifecycleStatus.ACTIVE || lifecycle === shared_1.AssayerLifecycleStatus.ON_LEAVE)
        return 'ACTIVE';
    if (lifecycle === shared_1.AssayerLifecycleStatus.SUSPENDED)
        return 'SUSPENDED';
    return 'INACTIVE';
}
let AssayerService = class AssayerService {
    assayerRepository;
    commercialRepository;
    workforceAttributeRepository;
    govDocRepository;
    assayerDocRepository;
    remarkRepository;
    activityRepository;
    auditService;
    constructor(assayerRepository, commercialRepository, workforceAttributeRepository, govDocRepository, assayerDocRepository, remarkRepository, activityRepository, auditService) {
        this.assayerRepository = assayerRepository;
        this.commercialRepository = commercialRepository;
        this.workforceAttributeRepository = workforceAttributeRepository;
        this.govDocRepository = govDocRepository;
        this.assayerDocRepository = assayerDocRepository;
        this.remarkRepository = remarkRepository;
        this.activityRepository = activityRepository;
        this.auditService = auditService;
    }
    async findAll(page = 1, limit = 50) {
        const [assayers, total] = await this.assayerRepository.findAndCount({
            where: { isActive: true },
            skip: (page - 1) * limit,
            take: limit,
            order: { createdAt: 'DESC' },
        });
        return { assayers, total };
    }
    async findOne(id) {
        const assayer = await this.assayerRepository.findOne({ where: { id, isActive: true } });
        if (!assayer)
            throw new common_1.NotFoundException(`Assayer ${id} not found.`);
        return assayer;
    }
    async create(dto, userId) {
        const existing = await this.assayerRepository.findOne({ where: { assayerCode: dto.assayerCode } });
        if (existing)
            throw new common_1.ConflictException(`Assayer code ${dto.assayerCode} already exists.`);
        let location = null;
        if (dto.latitude && dto.longitude) {
            location = { type: 'Point', coordinates: [dto.longitude, dto.latitude] };
        }
        const assayer = this.assayerRepository.create({
            ...dto,
            joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : null,
            displayName: `${dto.firstName} ${dto.lastName}`,
            location,
            lifecycleStatus: shared_1.AssayerLifecycleStatus.INVITED,
            status: 'INACTIVE',
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.assayerRepository.save(assayer);
        await this.recordActivity(saved.id, 'ASSAYER_CREATED', null, shared_1.AssayerLifecycleStatus.INVITED, userId, 'Assayer profile created');
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_CREATED',
            entityType: 'ASSAYER',
            entityId: saved.id,
            userId,
            remarks: `Created assayer profile: ${saved.displayName} (${saved.assayerCode})`,
        });
        return saved;
    }
    async update(id, dto, userId) {
        const assayer = await this.findOne(id);
        Object.keys(dto).forEach((key) => {
            if (dto[key] !== undefined)
                assayer[key] = dto[key];
        });
        if (dto.firstName || dto.lastName) {
            assayer.displayName = `${dto.firstName ?? assayer.firstName} ${dto.lastName ?? assayer.lastName}`;
        }
        if (dto.joiningDate)
            assayer.joiningDate = new Date(dto.joiningDate);
        if (dto.exitDate)
            assayer.exitDate = new Date(dto.exitDate);
        if (dto.terminationDate)
            assayer.terminationDate = new Date(dto.terminationDate);
        if (dto.latitude && dto.longitude) {
            assayer.location = { type: 'Point', coordinates: [dto.longitude, dto.latitude] };
        }
        assayer.updatedBy = userId;
        const saved = await this.assayerRepository.save(assayer);
        await this.recordActivity(saved.id, 'ASSAYER_UPDATED', null, null, userId, 'Profile updated');
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_UPDATED',
            entityType: 'ASSAYER',
            entityId: saved.id,
            userId,
            remarks: `Updated assayer profile: ${saved.displayName}`,
        });
        return saved;
    }
    async remove(id, userId) {
        const assayer = await this.findOne(id);
        assayer.isActive = false;
        assayer.updatedBy = userId;
        await this.assayerRepository.save(assayer);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_DELETED',
            entityType: 'ASSAYER',
            entityId: id,
            userId,
            remarks: `Soft deleted assayer profile ${assayer.displayName}`,
        });
    }
    async transitionLifecycle(id, targetStatus, userId, reason) {
        const assayer = await this.findOne(id);
        const currentStatus = assayer.lifecycleStatus;
        const allowed = LIFECYCLE_TRANSITIONS[currentStatus];
        if (!allowed || !allowed.includes(targetStatus)) {
            throw new common_1.BadRequestException(`Invalid lifecycle transition from '${currentStatus}' to '${targetStatus}'`);
        }
        assayer.lifecycleStatus = targetStatus;
        assayer.status = mapLifecycleToOperationalStatus(targetStatus);
        assayer.updatedBy = userId;
        if (targetStatus === shared_1.AssayerLifecycleStatus.ARCHIVED)
            assayer.isActive = false;
        const saved = await this.assayerRepository.save(assayer);
        await this.recordActivity(saved.id, 'LIFECYCLE_TRANSITION', currentStatus, targetStatus, userId, reason || null);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_LIFECYCLE_TRANSITION',
            entityType: 'ASSAYER',
            entityId: saved.id,
            previousState: currentStatus,
            newState: targetStatus,
            userId,
            remarks: reason || `Lifecycle transition: ${currentStatus} → ${targetStatus}`,
        });
        return saved;
    }
    async addGovernmentDocument(assayerId, dto, userId) {
        await this.findOne(assayerId);
        const existing = await this.govDocRepository.findOne({ where: { assayerId, documentType: dto.documentType, isActive: true } });
        if (existing)
            throw new common_1.ConflictException(`Active ${dto.documentType} document already exists for this assayer. Remove the existing document before adding a new one.`);
        const doc = this.govDocRepository.create({
            assayerId,
            ...dto,
            expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
            filePaths: dto.filePaths || [],
            verificationStatus: 'PENDING',
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.govDocRepository.save(doc);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'GOVERNMENT_DOCUMENT_ADDED',
            entityType: 'ASSAYER_GOVERNMENT_DOCUMENT',
            entityId: saved.id,
            userId,
            remarks: `Added ${dto.documentType} document for assayer ${assayerId}`,
        });
        await this.recordActivity(assayerId, 'GOVERNMENT_DOCUMENT_ADDED', null, null, userId, `Added ${dto.documentType} document`);
        return saved;
    }
    async updateGovernmentDocument(docId, dto, userId) {
        const doc = await this.govDocRepository.findOne({ where: { id: docId, isActive: true } });
        if (!doc)
            throw new common_1.NotFoundException(`Government document ${docId} not found.`);
        if (dto.documentNumber !== undefined)
            doc.documentNumber = dto.documentNumber;
        if (dto.expiryDate !== undefined)
            doc.expiryDate = dto.expiryDate ? new Date(dto.expiryDate) : null;
        if (dto.verificationStatus !== undefined) {
            doc.verificationStatus = dto.verificationStatus;
            if (dto.verificationStatus === 'VERIFIED' || dto.verificationStatus === 'REJECTED') {
                doc.verifiedAt = new Date();
                doc.verifiedBy = dto.verifiedBy || userId;
            }
        }
        if (dto.filePaths !== undefined)
            doc.filePaths = dto.filePaths;
        if (dto.remarks !== undefined)
            doc.remarks = dto.remarks;
        doc.updatedBy = userId;
        const saved = await this.govDocRepository.save(doc);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'GOVERNMENT_DOCUMENT_UPDATED',
            entityType: 'ASSAYER_GOVERNMENT_DOCUMENT',
            entityId: saved.id,
            userId,
            remarks: `Updated ${doc.documentType} document status: ${doc.verificationStatus}`,
        });
        await this.recordActivity(doc.assayerId, 'GOVERNMENT_DOCUMENT_UPDATED', null, null, userId, `Updated ${doc.documentType} document`);
        return saved;
    }
    async getGovernmentDocuments(assayerId) {
        return this.govDocRepository.find({
            where: { assayerId, isActive: true },
            order: { documentType: 'ASC' },
        });
    }
    async removeGovernmentDocument(docId, userId) {
        const doc = await this.govDocRepository.findOne({ where: { id: docId, isActive: true } });
        if (!doc)
            throw new common_1.NotFoundException(`Government document ${docId} not found.`);
        doc.isActive = false;
        doc.updatedBy = userId;
        await this.govDocRepository.save(doc);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'GOVERNMENT_DOCUMENT_REMOVED',
            entityType: 'ASSAYER_GOVERNMENT_DOCUMENT',
            entityId: docId,
            userId,
            remarks: `Removed ${doc.documentType} document`,
        });
        await this.recordActivity(doc.assayerId, 'GOVERNMENT_DOCUMENT_REMOVED', null, null, userId, `Removed ${doc.documentType} document`);
    }
    async addAssayerDocument(assayerId, dto, userId) {
        await this.findOne(assayerId);
        let docVersion = 1;
        if (dto.parentDocumentId) {
            const parent = await this.assayerDocRepository.findOne({ where: { id: dto.parentDocumentId } });
            if (parent)
                docVersion = parent.docVersion + 1;
        }
        const doc = this.assayerDocRepository.create({
            assayerId,
            ...dto,
            docVersion,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.assayerDocRepository.save(doc);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_DOCUMENT_ADDED',
            entityType: 'ASSAYER_DOCUMENT',
            entityId: saved.id,
            userId,
            remarks: `Added ${dto.documentType} (v${docVersion}) for assayer ${assayerId}`,
        });
        await this.recordActivity(assayerId, 'ASSAYER_DOCUMENT_ADDED', null, null, userId, `Added ${dto.documentType} (v${docVersion})`);
        return saved;
    }
    async getAssayerDocuments(assayerId) {
        return this.assayerDocRepository.find({
            where: { assayerId, isActive: true },
            order: { documentType: 'ASC', docVersion: 'DESC' },
        });
    }
    async updateAssayerDocument(docId, dto, userId) {
        const doc = await this.assayerDocRepository.findOne({ where: { id: docId, isActive: true } });
        if (!doc)
            throw new common_1.NotFoundException(`Assayer document ${docId} not found.`);
        if (dto.documentType !== undefined)
            doc.documentType = dto.documentType;
        if (dto.fileName !== undefined)
            doc.fileName = dto.fileName;
        if (dto.filePath !== undefined)
            doc.filePath = dto.filePath;
        if (dto.fileSize !== undefined)
            doc.fileSize = dto.fileSize;
        if (dto.mimeType !== undefined)
            doc.mimeType = dto.mimeType;
        if (dto.remarks !== undefined)
            doc.remarks = dto.remarks;
        doc.updatedBy = userId;
        const saved = await this.assayerDocRepository.save(doc);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_DOCUMENT_UPDATED',
            entityType: 'ASSAYER_DOCUMENT',
            entityId: docId,
            userId,
            remarks: `Updated ${doc.documentType} document (v${doc.docVersion})`,
        });
        await this.recordActivity(doc.assayerId, 'ASSAYER_DOCUMENT_UPDATED', null, null, userId, `Updated ${doc.documentType} document`);
        return saved;
    }
    async removeAssayerDocument(docId, userId) {
        const doc = await this.assayerDocRepository.findOne({ where: { id: docId, isActive: true } });
        if (!doc)
            throw new common_1.NotFoundException(`Assayer document ${docId} not found.`);
        doc.isActive = false;
        doc.updatedBy = userId;
        await this.assayerDocRepository.save(doc);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_DOCUMENT_REMOVED',
            entityType: 'ASSAYER_DOCUMENT',
            entityId: docId,
            userId,
            remarks: `Removed ${doc.documentType} document (v${doc.docVersion})`,
        });
        await this.recordActivity(doc.assayerId, 'ASSAYER_DOCUMENT_REMOVED', null, null, userId, `Removed ${doc.documentType} document`);
    }
    async addRemark(assayerId, dto, userId, userName) {
        await this.findOne(assayerId);
        const remark = this.remarkRepository.create({
            assayerId,
            authorId: userId,
            authorName: userName,
            content: dto.content,
            category: dto.category,
            visibility: dto.visibility,
            attachmentPaths: dto.attachmentPaths || [],
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.remarkRepository.save(remark);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_REMARK_ADDED',
            entityType: 'ASSAYER_REMARK',
            entityId: saved.id,
            userId,
            remarks: `Remark added for assayer ${assayerId} (${dto.category})`,
        });
        await this.recordActivity(assayerId, 'ASSAYER_REMARK_ADDED', null, null, userId, `Remark added (${dto.category})`);
        return saved;
    }
    async updateRemark(remarkId, dto, userId) {
        const remark = await this.remarkRepository.findOne({ where: { id: remarkId, isActive: true } });
        if (!remark)
            throw new common_1.NotFoundException(`Remark ${remarkId} not found.`);
        if (dto.content !== undefined)
            remark.content = dto.content;
        if (dto.category !== undefined)
            remark.category = dto.category;
        if (dto.visibility !== undefined)
            remark.visibility = dto.visibility;
        if (dto.attachmentPaths !== undefined)
            remark.attachmentPaths = dto.attachmentPaths;
        remark.updatedBy = userId;
        const saved = await this.remarkRepository.save(remark);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_REMARK_UPDATED',
            entityType: 'ASSAYER_REMARK',
            entityId: remarkId,
            userId,
            remarks: `Remark updated for assayer ${remark.assayerId}`,
        });
        await this.recordActivity(remark.assayerId, 'ASSAYER_REMARK_UPDATED', null, null, userId, `Remark updated`);
        return saved;
    }
    async removeRemark(remarkId, userId) {
        const remark = await this.remarkRepository.findOne({ where: { id: remarkId, isActive: true } });
        if (!remark)
            throw new common_1.NotFoundException(`Remark ${remarkId} not found.`);
        remark.isActive = false;
        remark.updatedBy = userId;
        await this.remarkRepository.save(remark);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_REMARK_REMOVED',
            entityType: 'ASSAYER_REMARK',
            entityId: remarkId,
            userId,
            remarks: `Remark removed for assayer ${remark.assayerId}`,
        });
        await this.recordActivity(remark.assayerId, 'ASSAYER_REMARK_REMOVED', null, null, userId, `Remark removed`);
    }
    async getRemarks(assayerId, visibility, page = 1, limit = 20) {
        const where = { assayerId, isActive: true };
        if (visibility)
            where.visibility = visibility;
        const [remarks, total] = await this.remarkRepository.findAndCount({
            where,
            order: { createdAt: 'DESC' },
            skip: (page - 1) * limit,
            take: limit,
        });
        return { remarks, total };
    }
    async recordActivity(assayerId, eventType, previousState, newState, userId, remarks) {
        const activity = this.activityRepository.create({
            assayerId,
            eventType,
            previousState,
            newState,
            performedBy: userId,
            performedByName: null,
            remarks,
            createdBy: userId,
            updatedBy: userId,
        });
        await this.activityRepository.save(activity);
    }
    async getActivityTimeline(assayerId, page = 1, limit = 20) {
        const [activities, total] = await this.activityRepository.findAndCount({
            where: { assayerId },
            order: { occurredAt: 'DESC' },
            skip: (page - 1) * limit,
            take: limit,
        });
        return { activities, total };
    }
    async createCommercialProfile(assayerId, dto, userId) {
        await this.findOne(assayerId);
        const profile = this.commercialRepository.create({
            ...dto,
            assayerId,
            effectiveStartDate: new Date(dto.effectiveStartDate),
            effectiveEndDate: dto.effectiveEndDate ? new Date(dto.effectiveEndDate) : null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.commercialRepository.save(profile);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_COMMERCIAL_PROFILE_CREATED',
            entityType: 'ASSAYER_COMMERCIAL_PROFILE',
            entityId: saved.id,
            userId,
            remarks: `Created commercial profile for assayer ${assayerId} with base fee ₹${dto.baseFee}`,
        });
        await this.recordActivity(assayerId, 'COMMERCIAL_PROFILE_CREATED', null, null, userId, `Commercial profile created with base fee ₹${dto.baseFee}`);
        return saved;
    }
    async updateCommercialProfile(profileId, dto, userId) {
        const profile = await this.commercialRepository.findOne({ where: { id: profileId, isActive: true } });
        if (!profile)
            throw new common_1.NotFoundException(`Commercial profile ${profileId} not found.`);
        if (dto.baseFee !== undefined)
            profile.baseFee = dto.baseFee;
        if (dto.hourlyRate !== undefined)
            profile.hourlyRate = dto.hourlyRate;
        if (dto.dailyRate !== undefined)
            profile.dailyRate = dto.dailyRate;
        if (dto.travelReimbursement !== undefined)
            profile.travelReimbursement = dto.travelReimbursement;
        if (dto.accommodationAllowance !== undefined)
            profile.accommodationAllowance = dto.accommodationAllowance;
        if (dto.mealAllowance !== undefined)
            profile.mealAllowance = dto.mealAllowance;
        if (dto.currency !== undefined)
            profile.currency = dto.currency;
        if (dto.effectiveStartDate !== undefined)
            profile.effectiveStartDate = new Date(dto.effectiveStartDate);
        if (dto.effectiveEndDate !== undefined)
            profile.effectiveEndDate = dto.effectiveEndDate ? new Date(dto.effectiveEndDate) : null;
        profile.updatedBy = userId;
        const saved = await this.commercialRepository.save(profile);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_COMMERCIAL_PROFILE_UPDATED',
            entityType: 'ASSAYER_COMMERCIAL_PROFILE',
            entityId: saved.id,
            userId,
            remarks: `Updated commercial profile ${profileId}`,
        });
        await this.recordActivity(profile.assayerId, 'COMMERCIAL_PROFILE_UPDATED', null, null, userId, `Commercial profile updated`);
        return saved;
    }
    async getCommercialProfiles(assayerId) {
        return this.commercialRepository.find({
            where: { assayerId, isActive: true },
            order: { effectiveStartDate: 'DESC' },
        });
    }
    async getActiveCommercialProfile(assayerId, date = new Date()) {
        const profiles = await this.commercialRepository.find({
            where: { assayerId, isActive: true, effectiveStartDate: (0, typeorm_2.LessThanOrEqual)(date) },
            order: { effectiveStartDate: 'DESC' },
        });
        for (const p of profiles) {
            if (!p.effectiveEndDate || p.effectiveEndDate >= date)
                return p;
        }
        return null;
    }
    async addWorkforceAttribute(assayerId, dto, userId) {
        await this.findOne(assayerId);
        const attr = this.workforceAttributeRepository.create({
            ...dto,
            assayerId,
            expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.workforceAttributeRepository.save(attr);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'WORKFORCE_ATTRIBUTE_CREATED',
            entityType: 'WORKFORCE_ATTRIBUTE',
            entityId: saved.id,
            userId,
            remarks: `Added ${dto.type} '${dto.name}' to assayer ${assayerId}`,
        });
        await this.recordActivity(assayerId, 'WORKFORCE_ATTRIBUTE_CREATED', null, null, userId, `Added ${dto.type} '${dto.name}'`);
        return saved;
    }
    async updateWorkforceAttribute(attributeId, dto, userId) {
        const attr = await this.workforceAttributeRepository.findOne({ where: { id: attributeId, isActive: true } });
        if (!attr)
            throw new common_1.NotFoundException(`Workforce attribute ${attributeId} not found.`);
        if (dto.name !== undefined)
            attr.name = dto.name;
        if (dto.level !== undefined)
            attr.level = dto.level;
        if (dto.expiryDate !== undefined)
            attr.expiryDate = dto.expiryDate ? new Date(dto.expiryDate) : null;
        if (dto.metadata !== undefined)
            attr.metadata = dto.metadata;
        attr.updatedBy = userId;
        const saved = await this.workforceAttributeRepository.save(attr);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'WORKFORCE_ATTRIBUTE_UPDATED',
            entityType: 'WORKFORCE_ATTRIBUTE',
            entityId: saved.id,
            userId,
            remarks: `Updated workforce attribute ${attributeId}`,
        });
        await this.recordActivity(attr.assayerId, 'WORKFORCE_ATTRIBUTE_UPDATED', null, null, userId, `Updated workforce attribute '${attr.name}'`);
        return saved;
    }
    async removeWorkforceAttribute(attributeId, userId) {
        const attr = await this.workforceAttributeRepository.findOne({ where: { id: attributeId, isActive: true } });
        if (!attr)
            throw new common_1.NotFoundException(`Workforce attribute ${attributeId} not found.`);
        attr.isActive = false;
        attr.updatedBy = userId;
        await this.workforceAttributeRepository.save(attr);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'WORKFORCE_ATTRIBUTE_DELETED',
            entityType: 'WORKFORCE_ATTRIBUTE',
            entityId: attributeId,
            userId,
            remarks: `Removed workforce attribute '${attr.name}' from assayer ${attr.assayerId}`,
        });
        await this.recordActivity(attr.assayerId, 'WORKFORCE_ATTRIBUTE_REMOVED', null, null, userId, `Removed workforce attribute '${attr.name}'`);
    }
    async getWorkforceAttributes(assayerId, type) {
        const where = { assayerId, isActive: true };
        if (type)
            where.type = type;
        return this.workforceAttributeRepository.find({ where, order: { type: 'ASC', name: 'ASC' } });
    }
};
exports.AssayerService = AssayerService;
exports.AssayerService = AssayerService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(assayer_entity_1.AssayerEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(assayer_commercial_profile_entity_1.AssayerCommercialProfileEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(workforce_attribute_entity_1.WorkforceAttributeEntity)),
    __param(3, (0, typeorm_1.InjectRepository)(assayer_government_document_entity_1.AssayerGovernmentDocumentEntity)),
    __param(4, (0, typeorm_1.InjectRepository)(assayer_document_entity_1.AssayerDocumentEntity)),
    __param(5, (0, typeorm_1.InjectRepository)(assayer_remark_entity_1.AssayerRemarkEntity)),
    __param(6, (0, typeorm_1.InjectRepository)(assayer_activity_entity_1.AssayerActivityEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        audit_service_1.AuditService])
], AssayerService);
//# sourceMappingURL=assayer.service.js.map
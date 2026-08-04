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
var AssayerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssayerService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const xlsx = require("xlsx");
const bcrypt = require("bcrypt");
const assayer_entity_1 = require("./assayer.entity");
const assayer_commercial_profile_entity_1 = require("./assayer-commercial-profile.entity");
const workforce_attribute_entity_1 = require("./workforce-attribute.entity");
const assayer_government_document_entity_1 = require("./assayer-government-document.entity");
const assayer_document_entity_1 = require("./assayer-document.entity");
const assayer_remark_entity_1 = require("./assayer-remark.entity");
const assayer_activity_entity_1 = require("./assayer-activity.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const assayer_state_machine_1 = require("./assayer.state-machine");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
const workflow_engine_1 = require("../platform/workflow/workflow.engine");
const shared_1 = require("@fapoms/shared");
const india_geocoder_1 = require("../geo/india-geocoder");
async function geocodeAddress(address, city, district, state, pincode) {
    return (0, india_geocoder_1.geocodeIndia)(address, city, district, state, pincode);
}
async function fetchPincodeAuthority(pincode) {
    if (!/^\d{6}$/.test(pincode))
        return null;
    await new Promise((r) => setTimeout(r, 600));
    try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(`${pincode}, India`)}&format=json&limit=1&countrycodes=in&addressdetails=1`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'fapoms-production-geocoder/1.0 (info@fapoms.com)' },
        });
        clearTimeout(timeoutId);
        if (!res.ok)
            return null;
        const data = (await res.json());
        const a = data?.[0]?.address;
        if (!a?.state)
            return null;
        return {
            state: a.state,
            district: a.state_district || a.county || a.city || a.town || a.village || '',
        };
    }
    catch {
        return null;
    }
}
function normalizePlace(s) {
    return (s || '')
        .toLowerCase()
        .replace(/\b(urban|rural|district|city|metro)\b/g, '')
        .replace(/[^a-z0-9]/g, '');
}
async function assertAddressConsistent(dto) {
    const pin = dto.pincode || (dto.address || '').match(/\b\d{6}\b/)?.[0] || '';
    if (!/^\d{6}$/.test(pin))
        return;
    const authority = await fetchPincodeAuthority(pin);
    if (!authority)
        return;
    const where = `${dto.state ?? 'unknown state'}, ${dto.district ?? 'unknown district'}`;
    if (dto.state &&
        authority.state &&
        normalizePlace(dto.state) !== normalizePlace(authority.state)) {
        throw new common_1.BadRequestException(`Pincode ${pin} is in ${authority.state}, but the entered state is "${dto.state}". ` +
            `State, district, city, address and pincode must all describe the same place (got ${where}).`);
    }
    if (dto.district &&
        authority.district &&
        normalizePlace(dto.district) !== normalizePlace(authority.district)) {
        throw new common_1.BadRequestException(`Pincode ${pin} is in ${authority.district} district (${authority.state}), but the entered district is "${dto.district}". ` +
            `State, district, city, address and pincode must all describe the same place (got ${where}).`);
    }
}
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
let AssayerService = AssayerService_1 = class AssayerService {
    assayerRepository;
    commercialRepository;
    workforceAttributeRepository;
    govDocRepository;
    assayerDocRepository;
    remarkRepository;
    activityRepository;
    auditService;
    eventPublisher;
    workflowEngine;
    logger = new common_1.Logger(AssayerService_1.name);
    constructor(assayerRepository, commercialRepository, workforceAttributeRepository, govDocRepository, assayerDocRepository, remarkRepository, activityRepository, auditService, eventPublisher, workflowEngine) {
        this.assayerRepository = assayerRepository;
        this.commercialRepository = commercialRepository;
        this.workforceAttributeRepository = workforceAttributeRepository;
        this.govDocRepository = govDocRepository;
        this.assayerDocRepository = assayerDocRepository;
        this.remarkRepository = remarkRepository;
        this.activityRepository = activityRepository;
        this.auditService = auditService;
        this.eventPublisher = eventPublisher;
        this.workflowEngine = workflowEngine;
    }
    onModuleInit() {
        this.workflowEngine.registerWorkflow('assayer', [
            { from: [shared_1.AssayerLifecycleStatus.INVITED], to: shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION },
            { from: [shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION], to: shared_1.AssayerLifecycleStatus.BACKGROUND_VERIFICATION },
            { from: [shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION], to: shared_1.AssayerLifecycleStatus.INACTIVE },
            { from: [shared_1.AssayerLifecycleStatus.BACKGROUND_VERIFICATION], to: shared_1.AssayerLifecycleStatus.TRAINING },
            { from: [shared_1.AssayerLifecycleStatus.BACKGROUND_VERIFICATION], to: shared_1.AssayerLifecycleStatus.INACTIVE },
            { from: [shared_1.AssayerLifecycleStatus.TRAINING], to: shared_1.AssayerLifecycleStatus.ACTIVE },
            { from: [shared_1.AssayerLifecycleStatus.TRAINING], to: shared_1.AssayerLifecycleStatus.INACTIVE },
            { from: [shared_1.AssayerLifecycleStatus.ACTIVE], to: shared_1.AssayerLifecycleStatus.ON_LEAVE },
            { from: [shared_1.AssayerLifecycleStatus.ACTIVE], to: shared_1.AssayerLifecycleStatus.SUSPENDED },
            { from: [shared_1.AssayerLifecycleStatus.ACTIVE], to: shared_1.AssayerLifecycleStatus.INACTIVE },
            { from: [shared_1.AssayerLifecycleStatus.ACTIVE], to: shared_1.AssayerLifecycleStatus.RESIGNED },
            { from: [shared_1.AssayerLifecycleStatus.ON_LEAVE], to: shared_1.AssayerLifecycleStatus.ACTIVE },
            { from: [shared_1.AssayerLifecycleStatus.ON_LEAVE], to: shared_1.AssayerLifecycleStatus.INACTIVE },
            { from: [shared_1.AssayerLifecycleStatus.SUSPENDED], to: shared_1.AssayerLifecycleStatus.ACTIVE },
            { from: [shared_1.AssayerLifecycleStatus.SUSPENDED], to: shared_1.AssayerLifecycleStatus.TERMINATED },
            { from: [shared_1.AssayerLifecycleStatus.INACTIVE], to: shared_1.AssayerLifecycleStatus.ACTIVE },
            { from: [shared_1.AssayerLifecycleStatus.INACTIVE], to: shared_1.AssayerLifecycleStatus.ARCHIVED },
            { from: [shared_1.AssayerLifecycleStatus.RESIGNED], to: shared_1.AssayerLifecycleStatus.ARCHIVED },
            { from: [shared_1.AssayerLifecycleStatus.TERMINATED], to: shared_1.AssayerLifecycleStatus.ARCHIVED },
        ]);
    }
    async hydrateWorkforceAttributes(assayer) {
        const attrs = await this.workforceAttributeRepository.find({
            where: { assayerId: assayer.id, isActive: true },
        });
        assayer.skills = attrs.filter(a => a.type === 'SKILL').map(a => a.name);
        assayer.certifications = attrs.filter(a => a.type === 'CERTIFICATION').map(a => ({
            name: a.name,
            expiryDate: a.expiryDate ? a.expiryDate.toISOString().split('T')[0] : null,
        }));
        assayer.languages = attrs.filter(a => a.type === 'LANGUAGE').map(a => a.name);
        assayer.specializations = attrs.filter(a => a.type === 'SPECIALIZATION').map(a => a.name);
        return assayer;
    }
    async hydrateAllWorkforceAttributes(assayers) {
        if (assayers.length === 0)
            return;
        const allAttrs = await this.workforceAttributeRepository.find({
            where: { assayerId: (0, typeorm_2.In)(assayers.map(a => a.id)), isActive: true },
        });
        const attrsMap = new Map();
        for (const attr of allAttrs) {
            if (!attrsMap.has(attr.assayerId))
                attrsMap.set(attr.assayerId, []);
            attrsMap.get(attr.assayerId).push(attr);
        }
        for (const assayer of assayers) {
            const attrs = attrsMap.get(assayer.id) || [];
            assayer.skills = attrs.filter(a => a.type === 'SKILL').map(a => a.name);
            assayer.certifications = attrs.filter(a => a.type === 'CERTIFICATION').map(a => ({
                name: a.name,
                expiryDate: a.expiryDate ? a.expiryDate.toISOString().split('T')[0] : null,
            }));
            assayer.languages = attrs.filter(a => a.type === 'LANGUAGE').map(a => a.name);
            assayer.specializations = attrs.filter(a => a.type === 'SPECIALIZATION').map(a => a.name);
        }
    }
    async syncWorkforceAttributes(assayerId, dto, userId) {
        const syncedFields = ['skills', 'certifications', 'languages', 'specializations'];
        const hasAny = syncedFields.some(f => dto[f] !== undefined);
        if (!hasAny)
            return;
        await this.workforceAttributeRepository.delete({
            assayerId,
            type: (0, typeorm_2.In)(['SKILL', 'CERTIFICATION', 'LANGUAGE', 'SPECIALIZATION']),
        });
        const newAttrs = [];
        if (dto.skills) {
            for (const skill of dto.skills) {
                newAttrs.push({ assayerId, type: 'SKILL', name: skill, createdBy: userId, updatedBy: userId });
            }
        }
        if (dto.certifications) {
            for (const cert of dto.certifications) {
                newAttrs.push({
                    assayerId, type: 'CERTIFICATION', name: cert.name,
                    expiryDate: cert.expiryDate ? new Date(cert.expiryDate) : null,
                    createdBy: userId, updatedBy: userId,
                });
            }
        }
        if (dto.languages) {
            for (const lang of dto.languages) {
                newAttrs.push({ assayerId, type: 'LANGUAGE', name: lang, createdBy: userId, updatedBy: userId });
            }
        }
        if (dto.specializations) {
            for (const spec of dto.specializations) {
                newAttrs.push({ assayerId, type: 'SPECIALIZATION', name: spec, createdBy: userId, updatedBy: userId });
            }
        }
        if (newAttrs.length > 0) {
            await this.workforceAttributeRepository.save(newAttrs);
        }
    }
    async findAll(page = 1, limit = 50) {
        const [assayers, total] = await this.assayerRepository.findAndCount({
            where: { isActive: true },
            skip: (page - 1) * limit,
            take: limit,
            order: { createdAt: 'DESC' },
        });
        await this.hydrateAllWorkforceAttributes(assayers);
        return { assayers, total };
    }
    async findOne(id) {
        const assayer = await this.assayerRepository.findOne({ where: { id, isActive: true } });
        if (!assayer)
            throw new common_1.NotFoundException(`Assayer ${id} not found.`);
        await this.hydrateWorkforceAttributes(assayer);
        return assayer;
    }
    async create(dto, userId, organizationId) {
        const existing = await this.assayerRepository.findOne({ where: { assayerCode: dto.assayerCode } });
        if (existing)
            throw new common_1.ConflictException(`Assayer code ${dto.assayerCode} already exists.`);
        await assertAddressConsistent(dto);
        let lat = dto.latitude;
        let lng = dto.longitude;
        if (!lat || !lng) {
            const coords = await geocodeAddress(dto.address, dto.city, dto.district, dto.state, dto.pincode);
            lat = coords?.lat ?? undefined;
            lng = coords?.lng ?? undefined;
            if (coords && coords.accuracyMeters > 0) {
                this.logger.log(`Assayer ${dto.assayerCode}: pinned at ±${coords.accuracyMeters}m ` +
                    `(${lat}, ${lng}) from "${dto.address}"`);
            }
            if (!coords) {
                this.logger.warn(`Assayer ${dto.assayerCode}: could not resolve coordinates from "${dto.address}" ` +
                    `(${dto.city}, ${dto.district}, ${dto.state}). Saved without a location — ` +
                    `they will not appear on the map and distance-based matching will skip them.`);
            }
        }
        const location = { type: 'Point', coordinates: [lng, lat] };
        const assayer = this.assayerRepository.create({
            ...dto,
            joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : null,
            displayName: `${dto.firstName} ${dto.lastName}`,
            latitude: lat,
            longitude: lng,
            location,
            lifecycleStatus: shared_1.AssayerLifecycleStatus.INVITED,
            status: shared_1.AssayerStatus.INACTIVE,
            organizationId: organizationId ?? null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.assayerRepository.save(assayer);
        await this.syncWorkforceAttributes(saved.id, dto, userId);
        await this.recordActivity(saved.id, 'ASSAYER_CREATED', null, shared_1.AssayerLifecycleStatus.INVITED, userId, 'Assayer profile created');
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_CREATED',
            entityType: 'ASSAYER',
            entityId: saved.id,
            userId,
            remarks: `Created assayer profile: ${saved.displayName} (${saved.assayerCode})`,
        });
        await this.eventPublisher.publish('assayer:created', {
            eventType: 'assayer:created',
            aggregateId: saved.id,
            userId,
            organizationId: saved.organizationId,
            payload: { id: saved.id, displayName: saved.displayName, assayerCode: saved.assayerCode },
        });
        await this.hydrateWorkforceAttributes(saved);
        return saved;
    }
    async update(id, dto, userId) {
        const assayer = await this.findOne(id);
        const orig = {
            address: assayer.address,
            city: assayer.city,
            district: assayer.district,
            state: assayer.state,
            pincode: assayer.pincode,
        };
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
        let lat = dto.latitude !== undefined ? dto.latitude : assayer.latitude;
        let lng = dto.longitude !== undefined ? dto.longitude : assayer.longitude;
        const addressChanged = dto.address !== undefined && dto.address !== orig.address;
        const cityChanged = dto.city !== undefined && dto.city !== orig.city;
        const districtChanged = dto.district !== undefined && dto.district !== orig.district;
        const stateChanged = dto.state !== undefined && dto.state !== orig.state;
        if (addressChanged || cityChanged || districtChanged || stateChanged) {
            await assertAddressConsistent({
                address: dto.address ?? orig.address,
                city: dto.city ?? orig.city,
                district: dto.district ?? orig.district,
                state: dto.state ?? orig.state,
                pincode: dto.pincode ?? orig.pincode,
            });
        }
        if ((addressChanged || cityChanged || districtChanged || stateChanged) && dto.latitude === undefined && dto.longitude === undefined) {
            const coords = await geocodeAddress(dto.address ?? orig.address, dto.city ?? orig.city, dto.district ?? orig.district, dto.state ?? orig.state, dto.pincode ?? orig.pincode);
            if (coords) {
                lat = coords.lat;
                lng = coords.lng;
                if (coords.accuracyMeters > 0) {
                    this.logger.log(`Assayer ${assayer.assayerCode}: re-pinned at ±${coords.accuracyMeters}m`);
                }
            }
        }
        if (lat && lng) {
            assayer.latitude = lat;
            assayer.longitude = lng;
            assayer.location = { type: 'Point', coordinates: [lng, lat] };
        }
        assayer.updatedBy = userId;
        const saved = await this.assayerRepository.save(assayer);
        await this.syncWorkforceAttributes(saved.id, dto, userId);
        await this.recordActivity(saved.id, 'ASSAYER_UPDATED', null, null, userId, 'Profile updated');
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_UPDATED',
            entityType: 'ASSAYER',
            entityId: saved.id,
            userId,
            remarks: `Updated assayer profile: ${saved.displayName}`,
        });
        await this.eventPublisher.publish('assayer:updated', {
            eventType: 'assayer:updated',
            aggregateId: saved.id,
            userId,
            organizationId: saved.organizationId,
            payload: { id: saved.id, displayName: saved.displayName },
        });
        await this.hydrateWorkforceAttributes(saved);
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
        await this.eventPublisher.publish('assayer:deleted', {
            eventType: 'assayer:deleted',
            aggregateId: id,
            userId,
            organizationId: assayer.organizationId,
            payload: { id, displayName: assayer.displayName },
        });
    }
    async transitionLifecycle(id, targetStatus, userId, reason) {
        if (targetStatus === shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION) {
            return this.verifyDocuments(id, userId, reason);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.BACKGROUND_VERIFICATION) {
            return this.initiateBackgroundCheck(id, userId, reason);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.TRAINING) {
            return this.startTraining(id, userId, reason);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.ACTIVE) {
            return this.activateAssayer(id, userId, reason);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.ON_LEAVE) {
            return this.putOnLeave(id, userId, reason);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.SUSPENDED) {
            return this.suspendAssayer(id, userId, reason);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.INACTIVE) {
            return this.deactivateAssayer(id, userId, reason);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.RESIGNED) {
            return this.acceptResignation(id, userId, reason);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.TERMINATED) {
            return this.terminateAssayer(id, userId, reason);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.ARCHIVED) {
            return this.archiveAssayer(id, userId, reason);
        }
        else {
            throw new common_1.BadRequestException(`Invalid target status: ${targetStatus}`);
        }
    }
    async bulkTransitionLifecycle(ids, targetStatus, userId, reason) {
        const validTargets = Object.values(shared_1.AssayerLifecycleStatus);
        if (!validTargets.includes(targetStatus)) {
            throw new common_1.BadRequestException(`Invalid target status: ${targetStatus}`);
        }
        const succeeded = [];
        const skipped = [];
        const failed = [];
        for (const id of ids) {
            try {
                const assayer = await this.findOne(id);
                const path = assayer_state_machine_1.AssayerStateMachine.findPathTo(assayer.lifecycleStatus, targetStatus);
                if (path === null) {
                    skipped.push({
                        id,
                        current: assayer.lifecycleStatus,
                        reason: `No valid path from ${assayer.lifecycleStatus} to ${targetStatus}`,
                    });
                    continue;
                }
                const from = assayer.lifecycleStatus;
                for (const step of path) {
                    const { saved, event } = await this.doTransitionLifecycle(id, step, userId, reason);
                    if (event)
                        this.eventPublisher.publish(event.constructor.name, event);
                    void saved;
                }
                succeeded.push({ id, from, to: targetStatus });
            }
            catch (e) {
                failed.push({ id, reason: e.message });
            }
        }
        return { succeeded, skipped, failed };
    }
    async doTransitionLifecycle(id, targetStatus, userId, reason, role = shared_1.SystemRole.SUPER_ADMINISTRATOR) {
        const assayer = await this.findOne(id);
        const currentStatus = assayer.lifecycleStatus;
        let event;
        if (targetStatus === shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION) {
            event = assayer_state_machine_1.AssayerStateMachine.verifyDocuments(assayer, userId);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.BACKGROUND_VERIFICATION) {
            event = assayer_state_machine_1.AssayerStateMachine.initiateBackgroundCheck(assayer, userId);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.TRAINING) {
            event = assayer_state_machine_1.AssayerStateMachine.startTraining(assayer, userId);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.ACTIVE) {
            event = assayer_state_machine_1.AssayerStateMachine.activate(assayer, userId);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.ON_LEAVE) {
            event = assayer_state_machine_1.AssayerStateMachine.putOnLeave(assayer, userId);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.SUSPENDED) {
            event = assayer_state_machine_1.AssayerStateMachine.suspend(assayer, userId);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.INACTIVE) {
            event = assayer_state_machine_1.AssayerStateMachine.deactivate(assayer, userId);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.RESIGNED) {
            event = assayer_state_machine_1.AssayerStateMachine.acceptResignation(assayer, userId);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.TERMINATED) {
            event = assayer_state_machine_1.AssayerStateMachine.terminate(assayer, userId);
        }
        else if (targetStatus === shared_1.AssayerLifecycleStatus.ARCHIVED) {
            event = assayer_state_machine_1.AssayerStateMachine.archive(assayer, userId);
        }
        else {
            throw new common_1.BadRequestException(`Invalid lifecycle status: ${targetStatus}`);
        }
        return this.workflowEngine.executeCommand('assayer', assayer.id, `${targetStatus}_Command`, currentStatus, targetStatus, userId, role, [], async () => {
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
            return { saved, event };
        });
    }
    async verifyDocuments(id, userId, reason) {
        const { saved, event } = await this.doTransitionLifecycle(id, shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION, userId, reason);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async initiateBackgroundCheck(id, userId, reason) {
        const { saved, event } = await this.doTransitionLifecycle(id, shared_1.AssayerLifecycleStatus.BACKGROUND_VERIFICATION, userId, reason);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async startTraining(id, userId, reason) {
        const { saved, event } = await this.doTransitionLifecycle(id, shared_1.AssayerLifecycleStatus.TRAINING, userId, reason);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async activateAssayer(id, userId, reason) {
        const { saved, event } = await this.doTransitionLifecycle(id, shared_1.AssayerLifecycleStatus.ACTIVE, userId, reason);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async putOnLeave(id, userId, reason) {
        const { saved, event } = await this.doTransitionLifecycle(id, shared_1.AssayerLifecycleStatus.ON_LEAVE, userId, reason);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async suspendAssayer(id, userId, reason) {
        const { saved, event } = await this.doTransitionLifecycle(id, shared_1.AssayerLifecycleStatus.SUSPENDED, userId, reason);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async deactivateAssayer(id, userId, reason) {
        const { saved, event } = await this.doTransitionLifecycle(id, shared_1.AssayerLifecycleStatus.INACTIVE, userId, reason);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async acceptResignation(id, userId, reason) {
        const { saved, event } = await this.doTransitionLifecycle(id, shared_1.AssayerLifecycleStatus.RESIGNED, userId, reason);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async terminateAssayer(id, userId, reason) {
        const { saved, event } = await this.doTransitionLifecycle(id, shared_1.AssayerLifecycleStatus.TERMINATED, userId, reason);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async archiveAssayer(id, userId, reason) {
        const { saved, event } = await this.doTransitionLifecycle(id, shared_1.AssayerLifecycleStatus.ARCHIVED, userId, reason);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
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
            rating: dto.rating ?? null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.remarkRepository.save(remark);
        if (dto.rating != null) {
            await this.recomputeAverageRating(assayerId);
        }
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
        if (dto.rating !== undefined)
            remark.rating = dto.rating;
        remark.updatedBy = userId;
        const saved = await this.remarkRepository.save(remark);
        if (dto.rating !== undefined) {
            await this.recomputeAverageRating(remark.assayerId);
        }
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
    async recomputeAverageRating(assayerId) {
        const result = await this.remarkRepository
            .createQueryBuilder('r')
            .select('AVG(r.rating)', 'avg')
            .where('r.assayerId = :assayerId', { assayerId })
            .andWhere('r.rating IS NOT NULL')
            .andWhere('r.isActive = :isActive', { isActive: true })
            .getRawOne();
        const avg = result?.avg ? parseFloat(Number(result.avg).toFixed(2)) : 0;
        await this.assayerRepository.update(assayerId, { averageRating: avg });
    }
    async updateAssayerStats(assayerId) {
        const mgr = this.assayerRepository.manager;
        const total = await mgr.count('assignments', { where: { assayerId, isActive: true } });
        const completedResult = await mgr.query(`SELECT COUNT(*) as cnt FROM assignments a
       LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
       WHERE a.assayer_id = $1 AND a.is_active = true
       AND (a.status = 'COMPLETED' OR pb.status IN ('AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'))`, [assayerId]);
        const completed = Number(completedResult[0]?.cnt ?? 0);
        const cancelled = await mgr.count('assignments', {
            where: { assayerId, status: shared_1.AssignmentStatus.CANCELLED, isActive: true },
        });
        const onTimeResult = await mgr.query(`SELECT COUNT(*) as cnt FROM assignments a
       LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
       WHERE a.assayer_id = $1 AND a.is_active = true
       AND (a.status = 'COMPLETED' OR pb.status IN ('AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'))
       AND (a.completion_date IS NULL OR a.scheduled_date IS NULL OR a.completion_date <= a.scheduled_date)`, [assayerId]);
        const finRes = await mgr.query(`SELECT 
         COALESCE(SUM(total_amount), 0)                                     AS total_earned,
         COALESCE(SUM(total_amount - paid_amount), 0)                      AS owed,
         COALESCE(SUM(paid_amount), 0)                                      AS paid,
         COALESCE(SUM(total_amount) FILTER (WHERE status = 'PENDING'), 0) AS awaiting_approval
       FROM assayer_payables
       WHERE assayer_id = $1 AND is_active = true
         AND status NOT IN ('DISPUTED', 'ON_HOLD')`, [assayerId]).catch(() => [{ total_earned: 0, owed: 0, paid: 0, awaiting_approval: 0 }]);
        const totalEarnedFromPayables = Number(finRes[0]?.total_earned ?? 0);
        const totalEarnedFromAssignments = await mgr.query(`SELECT COALESCE(SUM(COALESCE(a.agreed_fee, a.proposed_fee)), 0) AS total
         FROM assignments a
        WHERE a.assayer_id = $1 AND a.is_active = true
          AND a.status IN ('ACCEPTED', 'COMPLETED')`, [assayerId]).then(r => Number(r[0]?.total ?? 0)).catch(() => 0);
        const realTotalEarnings = totalEarnedFromPayables > 0 ? totalEarnedFromPayables : totalEarnedFromAssignments;
        const realRunningBalance = totalEarnedFromPayables > 0 ? Number(finRes[0]?.owed ?? 0) : totalEarnedFromAssignments;
        const lastAssignment = await mgr.query(`SELECT updated_at FROM assignments a
       WHERE a.assayer_id = $1 AND a.is_active = true
       ORDER BY a.updated_at DESC LIMIT 1`, [assayerId]);
        await this.assayerRepository.update(assayerId, {
            totalAssignments: total,
            completedAssignments: completed,
            cancelledAssignments: cancelled,
            onTimeCompletions: Number(onTimeResult[0]?.cnt ?? 0),
            totalEarnings: realTotalEarnings,
            lastAssignmentDate: lastAssignment[0]?.updated_at ?? null,
        });
        await this.recomputeAverageRating(assayerId);
    }
    async getProfile(assayerId) {
        const isUuid = /^[0-9a-fA-F-]{36}$/.test(assayerId);
        const where = isUuid
            ? [{ id: assayerId, isActive: true }]
            : [{ assayerCode: assayerId, isActive: true }, { employeeId: assayerId, isActive: true }];
        const assayer = await this.assayerRepository.findOne({ where });
        if (!assayer)
            throw new common_1.NotFoundException(`Assayer ${assayerId} not found.`);
        await this.updateAssayerStats(assayer.id).catch(err => console.error('Failed to update assayer stats in profile:', err));
        const updated = await this.assayerRepository.findOne({ where: { id: assayer.id } });
        const target = updated || assayer;
        await this.hydrateWorkforceAttributes(target);
        const mgr = this.assayerRepository.manager;
        const queryRes = await mgr.query(`SELECT COUNT(*) as cnt FROM validation_queries vq
       JOIN assignments a ON a.id = vq.assignment_id
       WHERE a.assayer_id = $1 AND vq.is_active = true`, [target.id]).catch(() => [{ cnt: 0 }]);
        target.queryCount = Number(queryRes[0]?.cnt ?? 0);
        const balanceRes = await mgr.query(`SELECT COALESCE(SUM(total_amount), 0)                                     AS total_earned,
              COALESCE(SUM(total_amount - paid_amount), 0)                      AS owed,
              COALESCE(SUM(paid_amount), 0)                                      AS paid,
              COALESCE(SUM(total_amount) FILTER (WHERE status = 'PENDING'), 0) AS awaiting_approval
         FROM assayer_payables
        WHERE assayer_id = $1 AND is_active = true
          AND status NOT IN ('DISPUTED', 'ON_HOLD')`, [target.id]).catch(() => [{ total_earned: 0, owed: 0, paid: 0, awaiting_approval: 0 }]);
        const totalEarnedFromPayables = Number(balanceRes[0]?.total_earned ?? 0);
        const totalEarnedFromAssignments = target.totalEarnings || 0;
        const finalEarnings = totalEarnedFromPayables > 0 ? totalEarnedFromPayables : totalEarnedFromAssignments;
        const finalBalance = totalEarnedFromPayables > 0 ? Number(balanceRes[0]?.owed ?? 0) : totalEarnedFromAssignments;
        target.totalEarnings = finalEarnings;
        target.runningBalance = finalBalance;
        target.earningsPaid = Number(balanceRes[0]?.paid ?? 0);
        target.earningsAwaitingApproval = Number(balanceRes[0]?.awaiting_approval ?? 0);
        const totalOffered = await mgr.count('assignments', { where: { assayerId: target.id, isActive: true } });
        const acceptedCount = await mgr.count('assignments', { where: { assayerId: target.id, status: (0, typeorm_2.In)([shared_1.AssignmentStatus.ACCEPTED, shared_1.AssignmentStatus.COMPLETED]), isActive: true } });
        const rejectedCount = await mgr.count('assignments', { where: { assayerId: target.id, status: shared_1.AssignmentStatus.REJECTED, isActive: true } });
        target.acceptanceRate = totalOffered > 0 ? Math.round((acceptedCount / totalOffered) * 100) : 100;
        target.rejectionRate = totalOffered > 0 ? Math.round((rejectedCount / totalOffered) * 100) : 0;
        const auditHistory = await mgr.query(`SELECT a.id, a.assignment_number, a.status, a.agreed_fee, a.proposed_fee, a.scheduled_date, a.completion_date,
              b.name as branch_name, b.city as branch_city, b.state as branch_state, p.name as project_name
       FROM assignments a
       LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
       LEFT JOIN branches b ON b.id = pb.branch_id
       LEFT JOIN projects p ON p.id = pb.project_id
       WHERE a.assayer_id = $1 AND a.is_active = true
       ORDER BY a.created_at DESC LIMIT 20`, [target.id]).catch(() => []);
        target.auditHistory = auditHistory;
        const activeCommercial = await this.getActiveCommercialProfile(target.id, new Date()).catch(() => null);
        target.activeCommercialProfile = activeCommercial;
        return target;
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
        return { activities: await this.withActorNames(activities), total };
    }
    async withActorNames(activities) {
        const ids = [...new Set(activities.map((a) => a.performedBy).filter(Boolean))];
        if (ids.length === 0)
            return activities;
        const names = new Map();
        const rows = await this.activityRepository.manager.query(`SELECT id, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), ''), username) AS name
         FROM users WHERE id = ANY($1)
       UNION ALL
       SELECT id, display_name AS name FROM assayers WHERE id = ANY($1)`, [ids]);
        for (const r of rows)
            names.set(r.id, r.name);
        return activities.map((a) => {
            if (!a.performedByName && a.performedBy && names.has(a.performedBy)) {
                a.performedByName = names.get(a.performedBy);
            }
            return a;
        });
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
    async generateTemplate() {
        const headers = [
            'Assayer code', 'Assayer Name', 'Phone', 'Residence Address', 'Initial Password',
            'Location', 'District', 'State', 'Zone', 'Pincode', 'Preferred Regions',
            'Email', 'Alternate Phone',
            'Employment Type', 'Employee ID', 'Department', 'Joining Date',
            'Skills', 'Certifications', 'Specializations', 'Languages',
            'Experience (Years)', 'Performance Rating',
            'Max Daily Workload', 'Max Weekly Workload',
            'Working Hours Start', 'Working Hours End',
            'Base Fee', 'Daily Rate', 'Hourly Rate',
            'Travel Reimbursement', 'Accommodation Allowance', 'Meal Allowance',
            'PAN Number', 'Bank Account Number', 'IFSC Code',
            'Emergency Contact Name', 'Emergency Contact Phone', 'Emergency Contact Relation',
        ];
        const ws = xlsx.utils.json_to_sheet([], { header: headers });
        ws['!cols'] = headers.map((h) => ({ wch: h === 'Residence Address' ? 50 : Math.max(16, h.length + 4) }));
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Assayers');
        const instructions = [
            { Field: 'Assayer code', Required: 'Yes', Description: 'Unique code, e.g. AS0643. Re-importing the same code updates that assayer instead of creating a duplicate.' },
            { Field: 'Assayer Name', Required: 'Yes', Description: 'Full name in one cell, e.g. "Shinil T". Split automatically — the last word is taken as the surname.' },
            { Field: 'Phone', Required: 'Yes', Description: "The assayer's login identifier AND how dispatch notifications reach them. A record without it cannot be used." },
            { Field: 'Residence Address', Required: 'Yes', Description: 'Full address. Used to compute travel distance to branches; a 6-digit pincode inside this text is picked up automatically.' },
            { Field: 'Initial Password', Required: 'No', Description: "Password the assayer signs in with. Defaults to 'assayer123' when blank. Only applied when the assayer is first created — re-importing a roster never resets an existing password." },
            { Field: 'Location', Required: 'No', Description: 'Town or locality, e.g. Kunnamangalam. Stored as the city.' },
            { Field: 'District', Required: 'No', Description: 'Used for travel distance and coverage planning.' },
            { Field: 'State', Required: 'No', Description: 'Used to apply state-specific public holidays to this assayer.' },
            { Field: 'Zone', Required: 'No', Description: 'Operating zone, e.g. South. Casing is normalised, so "north" and "North" are one zone.' },
            { Field: 'Pincode', Required: 'No', Description: 'Leave blank if already present in the address.' },
            { Field: 'Preferred Regions', Required: 'No', Description: 'Comma-separated. Regions this assayer prefers; improves their match score for branches there.' },
            { Field: 'Email', Required: 'No', Description: 'Used for notifications where available.' },
            { Field: 'Alternate Phone', Required: 'No', Description: 'Secondary contact number.' },
            { Field: 'Employment Type', Required: 'No', Description: 'INTERNAL / EXTERNAL / CONTRACT.' },
            { Field: 'Employee ID', Required: 'No', Description: 'HR identifier, for internal staff.' },
            { Field: 'Department', Required: 'No', Description: 'Department name.' },
            { Field: 'Joining Date', Required: 'No', Description: 'YYYY-MM-DD.' },
            { Field: 'Skills', Required: 'No', Description: 'Comma-separated, e.g. Gold Assaying, Hallmarking. A branch or client that requires a skill will only be matched to assayers who have it — blank means this assayer is excluded from any such work.' },
            { Field: 'Certifications', Required: 'No', Description: 'Semicolon-separated as Name|YYYY-MM-DD, e.g. Certified Gold Assayer|2027-06-01. Expiry is enforced: an expired certification blocks assignment to work requiring it.' },
            { Field: 'Specializations', Required: 'No', Description: 'Comma-separated areas of speciality.' },
            { Field: 'Languages', Required: 'No', Description: 'Comma-separated, e.g. English, Malayalam, Tamil. Used to match assayers to branches where the language matters.' },
            { Field: 'Experience (Years)', Required: 'No', Description: 'Whole number. Feeds the match score.' },
            { Field: 'Performance Rating', Required: 'No', Description: '1.00 – 10.00. Feeds the match score; leave blank to let the system derive it from completed work.' },
            { Field: 'Max Daily Workload', Required: 'No', Description: 'Branches per day. Defaults to 3. The day planner will not exceed this.' },
            { Field: 'Max Weekly Workload', Required: 'No', Description: 'Branches per week. Defaults to 15. Enforced when scheduling.' },
            { Field: 'Working Hours Start', Required: 'No', Description: 'e.g. 09:00. Used to fit branches into a realistic working day.' },
            { Field: 'Working Hours End', Required: 'No', Description: 'e.g. 18:00.' },
            { Field: 'Base Fee', Required: 'No', Description: 'Standard fee per audit for this assayer. Used as the opening offer during negotiation and as the cost side of every audit they perform.' },
            { Field: 'Daily Rate', Required: 'No', Description: 'Day rate where the engagement is priced per day rather than per audit.' },
            { Field: 'Hourly Rate', Required: 'No', Description: 'Hourly rate, where applicable.' },
            { Field: 'Travel Reimbursement', Required: 'No', Description: 'Travel paid per assignment. This is recharged to the client where their contract allows, so leaving it blank understates both cost and recoverable revenue.' },
            { Field: 'Accommodation Allowance', Required: 'No', Description: 'Paid for overnight assignments.' },
            { Field: 'Meal Allowance', Required: 'No', Description: 'Paid per assignment day.' },
            { Field: 'PAN Number', Required: 'No', Description: 'Needed before payment; TDS is withheld against it.' },
            { Field: 'Bank Account Number', Required: 'No', Description: 'Needed to disburse fees.' },
            { Field: 'IFSC Code', Required: 'No', Description: 'Needed to disburse fees.' },
            { Field: 'Emergency Contact Name', Required: 'No', Description: 'Emergency contact person.' },
            { Field: 'Emergency Contact Phone', Required: 'No', Description: 'Emergency contact number.' },
            { Field: 'Emergency Contact Relation', Required: 'No', Description: 'Relationship to the assayer.' },
        ];
        const instrWs = xlsx.utils.json_to_sheet(instructions, { header: ['Field', 'Required', 'Description'] });
        instrWs['!cols'] = [{ wch: 26 }, { wch: 10 }, { wch: 95 }];
        xlsx.utils.book_append_sheet(wb, instrWs, 'Instructions');
        return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    }
    async uploadFromExcel(fileBuffer, userId) {
        const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(worksheet);
        const errors = [];
        let importedCount = 0;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNum = i + 2;
            try {
                const assayerCode = (row['Assayer Code'] || row['Assayer code'] || '').toString().trim();
                if (!assayerCode) {
                    errors.push(`Row ${rowNum}: Assayer Code is required`);
                    continue;
                }
                let firstName = (row['First Name'] || '').toString().trim();
                let lastName = (row['Last Name'] || '').toString().trim();
                const combinedName = (row['Assayer Name'] || row['Name'] || '').toString().trim();
                if ((!firstName || !lastName) && combinedName) {
                    const parts = combinedName.split(/\s+/).filter(Boolean);
                    if (parts.length === 1) {
                        firstName = firstName || parts[0];
                        lastName = lastName || parts[0];
                    }
                    else {
                        firstName = firstName || parts.slice(0, -1).join(' ');
                        lastName = lastName || parts[parts.length - 1];
                    }
                }
                if (!firstName) {
                    errors.push(`Row ${rowNum} (${assayerCode}): provide 'Assayer Name' or 'First Name'`);
                    continue;
                }
                if (!lastName)
                    lastName = firstName;
                const phone = (row['Phone'] || row['Mobile'] || row['Contact Number'] || '').toString().trim();
                if (!phone) {
                    errors.push(`Row ${rowNum} (${assayerCode}): Phone is required — it is the login identifier and how dispatch notifications reach this assayer`);
                    continue;
                }
                const dto = {
                    assayerCode,
                    firstName,
                    lastName,
                    displayName: (row['Display Name'] || '').toString().trim() || `${firstName} ${lastName}`,
                    email: (row['Email'] || '').toString().trim() || undefined,
                    phone,
                    alternatePhone: (row['Alternate Phone'] || '').toString().trim() || undefined,
                    address: (row['Address'] || row['Residence Address'] || '').toString().trim(),
                    state: (row['State'] || '').toString().trim(),
                    district: (row['District'] || '').toString().trim(),
                    city: (row['City'] || row['Location'] || '').toString().trim(),
                    pincode: (row['Pincode'] || '').toString().trim()
                        || (String(row['Residence Address'] || '').match(/\b\d{6}\b/)?.[0] ?? undefined),
                    region: ((row['Region'] || row['Zone'] || '').toString().trim() || undefined)
                        && (row['Region'] || row['Zone']).toString().trim().replace(/\b\w/g, (c) => c.toUpperCase()),
                    employeeId: (row['Employee ID'] || '').toString().trim() || undefined,
                    employeeCode: (row['Employee Code'] || '').toString().trim() || undefined,
                    employmentType: (row['Employment Type'] || '').toString().trim() || undefined,
                    department: (row['Department'] || '').toString().trim() || undefined,
                    joiningDate: (row['Joining Date'] || '').toString().trim() || undefined,
                    panNumber: (row['PAN Number'] || '').toString().trim() || undefined,
                    bankAccountNumber: (row['Bank Account Number'] || '').toString().trim() || undefined,
                    ifscCode: (row['IFSC Code'] || '').toString().trim() || undefined,
                    experienceYears: parseInt(row['Experience (Years)'], 10) || undefined,
                    performanceRating: parseFloat(row['Performance Rating']) || undefined,
                    maxDailyWorkload: parseInt(row['Max Daily Workload'], 10) || undefined,
                    maxWeeklyWorkload: parseInt(row['Max Weekly Workload'], 10) || undefined,
                    emergencyContactName: (row['Emergency Contact Name'] || '').toString().trim() || undefined,
                    emergencyContactPhone: (row['Emergency Contact Phone'] || '').toString().trim() || undefined,
                    emergencyContactRelation: (row['Emergency Contact Relation'] || '').toString().trim() || undefined,
                    workingHours: undefined,
                };
                const skills = (row['Skills (comma-separated)'] || row['Skills'] || '').toString().trim();
                if (skills)
                    dto.skills = skills.split(',').map((s) => s.trim()).filter(Boolean);
                const languages = (row['Languages (comma-separated)'] || row['Languages'] || '').toString().trim();
                if (languages)
                    dto.languages = languages.split(',').map((s) => s.trim()).filter(Boolean);
                const prefs = (row['Preferred Regions (comma-separated)'] || row['Preferred Regions'] || '').toString().trim();
                if (prefs)
                    dto.preferredRegions = prefs.split(',').map((s) => s.trim()).filter(Boolean);
                const specializations = (row['Specializations (comma-separated)'] || row['Specializations'] || '').toString().trim();
                if (specializations)
                    dto.specializations = specializations.split(',').map((s) => s.trim()).filter(Boolean);
                const certs = (row['Certifications (semicolon-separated: Name|YYYY-MM-DD)'] || row['Certifications'] || '').toString().trim();
                if (certs) {
                    dto.certifications = certs.split(';').map((c) => {
                        const [name, expiryDate] = c.split('|').map((p) => p.trim());
                        return { name: name || c.trim(), expiryDate: expiryDate || undefined };
                    }).filter((c) => c.name);
                }
                const whStart = (row['Working Hours Start'] || '').toString().trim();
                const whEnd = (row['Working Hours End'] || '').toString().trim();
                if (whStart && whEnd) {
                    dto.workingHours = { start: whStart, end: whEnd };
                }
                const existing = await this.assayerRepository.findOne({ where: { assayerCode } });
                const saved = existing
                    ? await this.update(existing.id, dto, userId)
                    : await this.create(dto, userId);
                if (!existing) {
                    const supplied = (row['Initial Password'] || row['Password'] || '').toString().trim();
                    const initial = supplied || 'assayer123';
                    await this.assayerRepository.update(saved.id, {
                        passwordHash: await bcrypt.hash(initial, 12),
                    });
                }
                const num = (v) => {
                    const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
                    return Number.isFinite(n) ? n : undefined;
                };
                const rates = {
                    baseFee: num(row['Base Fee']),
                    dailyRate: num(row['Daily Rate']),
                    hourlyRate: num(row['Hourly Rate']),
                    travelReimbursement: num(row['Travel Reimbursement']),
                    accommodationAllowance: num(row['Accommodation Allowance']),
                    mealAllowance: num(row['Meal Allowance']),
                };
                if (Object.values(rates).some((v) => v !== undefined)) {
                    const activeProfile = await this.commercialRepository.findOne({
                        where: { assayerId: saved.id, isActive: true },
                        order: { effectiveStartDate: 'DESC' },
                    }).catch(() => null);
                    const payload = {
                        baseFee: rates.baseFee ?? activeProfile?.baseFee ?? 0,
                        dailyRate: rates.dailyRate ?? activeProfile?.dailyRate ?? 0,
                        hourlyRate: rates.hourlyRate ?? activeProfile?.hourlyRate ?? 0,
                        travelReimbursement: rates.travelReimbursement ?? activeProfile?.travelReimbursement ?? 0,
                        accommodationAllowance: rates.accommodationAllowance ?? activeProfile?.accommodationAllowance ?? 0,
                        mealAllowance: rates.mealAllowance ?? activeProfile?.mealAllowance ?? 0,
                    };
                    if (activeProfile) {
                        await this.commercialRepository.save({ ...activeProfile, ...payload, updatedBy: userId });
                    }
                    else {
                        await this.createCommercialProfile(saved.id, { ...payload, currency: 'INR', effectiveStartDate: new Date().toISOString() }, userId);
                    }
                }
                importedCount++;
            }
            catch (err) {
                errors.push(`Row ${rowNum}: ${err.message}`);
            }
        }
        return { importedCount, errors };
    }
};
exports.AssayerService = AssayerService;
exports.AssayerService = AssayerService = AssayerService_1 = __decorate([
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
        audit_service_1.AuditService,
        domain_event_publisher_1.DomainEventPublisher,
        workflow_engine_1.WorkflowEngine])
], AssayerService);
//# sourceMappingURL=assayer.service.js.map
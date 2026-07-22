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
exports.ClientService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const client_entity_1 = require("./client.entity");
const client_configuration_entity_1 = require("./client-configuration.entity");
const client_contact_entity_1 = require("./client-contact.entity");
const client_contract_entity_1 = require("./client-contract.entity");
const client_billing_entity_1 = require("./client-billing.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
const VALID_LIFECYCLE_TRANSITIONS = {
    [shared_1.ClientLifecycleStatus.PROSPECT]: [shared_1.ClientLifecycleStatus.ONBOARDING, shared_1.ClientLifecycleStatus.ARCHIVED],
    [shared_1.ClientLifecycleStatus.ONBOARDING]: [shared_1.ClientLifecycleStatus.ACTIVE, shared_1.ClientLifecycleStatus.INACTIVE],
    [shared_1.ClientLifecycleStatus.ACTIVE]: [shared_1.ClientLifecycleStatus.SUSPENDED, shared_1.ClientLifecycleStatus.UNDER_REVIEW, shared_1.ClientLifecycleStatus.INACTIVE],
    [shared_1.ClientLifecycleStatus.SUSPENDED]: [shared_1.ClientLifecycleStatus.ACTIVE, shared_1.ClientLifecycleStatus.UNDER_REVIEW, shared_1.ClientLifecycleStatus.TERMINATED],
    [shared_1.ClientLifecycleStatus.UNDER_REVIEW]: [shared_1.ClientLifecycleStatus.ACTIVE, shared_1.ClientLifecycleStatus.SUSPENDED, shared_1.ClientLifecycleStatus.TERMINATED],
    [shared_1.ClientLifecycleStatus.INACTIVE]: [shared_1.ClientLifecycleStatus.ACTIVE, shared_1.ClientLifecycleStatus.ARCHIVED],
    [shared_1.ClientLifecycleStatus.TERMINATED]: [shared_1.ClientLifecycleStatus.ARCHIVED],
    [shared_1.ClientLifecycleStatus.ARCHIVED]: [],
};
let ClientService = class ClientService {
    clientRepository;
    configRepository;
    contactRepository;
    contractRepository;
    billingRepository;
    auditService;
    constructor(clientRepository, configRepository, contactRepository, contractRepository, billingRepository, auditService) {
        this.clientRepository = clientRepository;
        this.configRepository = configRepository;
        this.contactRepository = contactRepository;
        this.contractRepository = contractRepository;
        this.billingRepository = billingRepository;
        this.auditService = auditService;
    }
    async create(dto, userId) {
        const existing = await this.clientRepository.findOne({ where: { clientCode: dto.clientCode } });
        if (existing) {
            throw new common_1.ConflictException(`Client code ${dto.clientCode} already exists.`);
        }
        const config = this.configRepository.create({
            importMapping: dto.configuration?.importMapping ?? {},
            workingDays: dto.configuration?.workingDays ?? [1, 2, 3, 4, 5],
            defaultRadius: dto.configuration?.defaultRadius ?? 50.0,
            slaRules: dto.configuration?.slaRules ?? {},
            serviceLevel: dto.configuration?.serviceLevel ?? null,
            maxResponseTimeHours: dto.configuration?.maxResponseTimeHours ?? null,
            penaltyRate: dto.configuration?.penaltyRate ?? null,
            serviceHours: dto.configuration?.serviceHours ?? null,
            effectiveFrom: new Date(),
            createdBy: userId,
            updatedBy: userId,
        });
        const client = this.clientRepository.create({
            clientCode: dto.clientCode,
            name: dto.name,
            displayName: dto.displayName,
            website: dto.website ?? null,
            industry: dto.industry ?? null,
            clientType: dto.clientType ?? 'OTHER',
            registrationNumber: dto.registrationNumber ?? null,
            taxId: dto.taxId ?? null,
            lifecycleStatus: shared_1.ClientLifecycleStatus.PROSPECT,
            contactPerson: dto.contactPerson ?? null,
            contactEmail: dto.contactEmail ?? null,
            contactPhone: dto.contactPhone ?? null,
            address: dto.address ?? null,
            priority: dto.priority ?? 'MEDIUM',
            budget: dto.budget ?? null,
            preferredAssayers: dto.preferredAssayers ?? null,
            restrictedAssayers: dto.restrictedAssayers ?? null,
            planningPreferences: dto.planningPreferences ?? null,
            createdBy: userId,
            updatedBy: userId,
            configuration: config,
        });
        const saved = await this.clientRepository.save(client);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'CLIENT_CREATED',
            entityType: 'CLIENT',
            entityId: saved.id,
            userId,
            remarks: `Created client ${saved.name} (${saved.clientCode})`,
        });
        return saved;
    }
    async findOne(id) {
        const client = await this.clientRepository.findOne({
            where: { id, isActive: true },
            relations: ['configuration', 'contacts', 'contracts', 'billing'],
        });
        if (!client) {
            throw new common_1.NotFoundException(`Client ${id} not found.`);
        }
        return client;
    }
    async findAll(page = 1, limit = 20) {
        const [clients, total] = await this.clientRepository.findAndCount({
            where: { isActive: true },
            relations: ['configuration'],
            take: limit,
            skip: (page - 1) * limit,
            order: { name: 'ASC' },
        });
        return { clients, total };
    }
    async update(id, dto, userId) {
        const client = await this.findOne(id);
        if (dto.name !== undefined)
            client.name = dto.name;
        if (dto.displayName !== undefined)
            client.displayName = dto.displayName;
        if (dto.website !== undefined)
            client.website = dto.website;
        if (dto.industry !== undefined)
            client.industry = dto.industry;
        if (dto.clientType !== undefined)
            client.clientType = dto.clientType;
        if (dto.registrationNumber !== undefined)
            client.registrationNumber = dto.registrationNumber;
        if (dto.taxId !== undefined)
            client.taxId = dto.taxId;
        if (dto.contactPerson !== undefined)
            client.contactPerson = dto.contactPerson;
        if (dto.contactEmail !== undefined)
            client.contactEmail = dto.contactEmail;
        if (dto.contactPhone !== undefined)
            client.contactPhone = dto.contactPhone;
        if (dto.address !== undefined)
            client.address = dto.address;
        if (dto.priority !== undefined)
            client.priority = dto.priority;
        if (dto.budget !== undefined)
            client.budget = dto.budget;
        if (dto.preferredAssayers !== undefined)
            client.preferredAssayers = dto.preferredAssayers;
        if (dto.restrictedAssayers !== undefined)
            client.restrictedAssayers = dto.restrictedAssayers;
        if (dto.planningPreferences !== undefined)
            client.planningPreferences = dto.planningPreferences;
        if (dto.configuration && client.configuration) {
            const conf = client.configuration;
            if (dto.configuration.importMapping !== undefined)
                conf.importMapping = dto.configuration.importMapping;
            if (dto.configuration.workingDays !== undefined)
                conf.workingDays = dto.configuration.workingDays;
            if (dto.configuration.defaultRadius !== undefined)
                conf.defaultRadius = dto.configuration.defaultRadius;
            if (dto.configuration.slaRules !== undefined)
                conf.slaRules = dto.configuration.slaRules;
            if (dto.configuration.serviceLevel !== undefined)
                conf.serviceLevel = dto.configuration.serviceLevel;
            if (dto.configuration.maxResponseTimeHours !== undefined)
                conf.maxResponseTimeHours = dto.configuration.maxResponseTimeHours;
            if (dto.configuration.penaltyRate !== undefined)
                conf.penaltyRate = dto.configuration.penaltyRate;
            if (dto.configuration.serviceHours !== undefined)
                conf.serviceHours = dto.configuration.serviceHours;
            if (dto.configuration.effectiveTo !== undefined)
                conf.effectiveTo = dto.configuration.effectiveTo;
            conf.updatedBy = userId;
        }
        client.updatedBy = userId;
        const saved = await this.clientRepository.save(client);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'CLIENT_UPDATED',
            entityType: 'CLIENT',
            entityId: id,
            userId,
            remarks: `Updated client ${client.name}`,
        });
        return saved;
    }
    async remove(id, userId) {
        const client = await this.findOne(id);
        client.isActive = false;
        client.updatedBy = userId;
        await this.clientRepository.save(client);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'CLIENT_DELETED',
            entityType: 'CLIENT',
            entityId: id,
            userId,
            remarks: `Soft deleted client ${client.name}`,
        });
    }
    async transitionLifecycle(id, newStatus, userId, reason) {
        const client = await this.findOne(id);
        const currentStatus = client.lifecycleStatus;
        const allowed = VALID_LIFECYCLE_TRANSITIONS[currentStatus] || [];
        if (!allowed.includes(newStatus)) {
            throw new common_1.BadRequestException(`Cannot transition from ${currentStatus} to ${newStatus}. Allowed: ${allowed.join(', ') || 'none'}`);
        }
        client.lifecycleStatus = newStatus;
        client.updatedBy = userId;
        const saved = await this.clientRepository.save(client);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'CLIENT_LIFECYCLE_CHANGED',
            entityType: 'CLIENT',
            entityId: id,
            previousState: currentStatus,
            newState: newStatus,
            userId,
            remarks: reason || `Lifecycle transitioned from ${currentStatus} to ${newStatus}`,
        });
        return saved;
    }
    async findContacts(clientId) {
        await this.findOne(clientId);
        return this.contactRepository.find({ where: { clientId, isActive: true } });
    }
    async addContact(clientId, dto, userId) {
        await this.findOne(clientId);
        if (dto.isPrimary) {
            await this.contactRepository.update({ clientId, isPrimary: true }, { isPrimary: false });
        }
        const contact = this.contactRepository.create({
            clientId,
            name: dto.name,
            email: dto.email,
            phone: dto.phone,
            designation: dto.designation,
            department: dto.department ?? null,
            isPrimary: dto.isPrimary ?? false,
            notes: dto.notes ?? null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.contactRepository.save(contact);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'CLIENT_CONTACT_CREATED',
            entityType: 'CLIENT',
            entityId: clientId,
            userId,
            remarks: `Added contact ${saved.name}`,
        });
        return saved;
    }
    async updateContact(contactId, dto, userId) {
        const contact = await this.contactRepository.findOne({ where: { id: contactId, isActive: true } });
        if (!contact) {
            throw new common_1.NotFoundException(`Contact ${contactId} not found.`);
        }
        if (dto.isPrimary) {
            await this.contactRepository.update({ clientId: contact.clientId, isPrimary: true }, { isPrimary: false });
        }
        if (dto.name !== undefined)
            contact.name = dto.name;
        if (dto.email !== undefined)
            contact.email = dto.email;
        if (dto.phone !== undefined)
            contact.phone = dto.phone;
        if (dto.designation !== undefined)
            contact.designation = dto.designation;
        if (dto.department !== undefined)
            contact.department = dto.department;
        if (dto.isPrimary !== undefined)
            contact.isPrimary = dto.isPrimary;
        if (dto.notes !== undefined)
            contact.notes = dto.notes;
        contact.updatedBy = userId;
        return this.contactRepository.save(contact);
    }
    async removeContact(contactId, userId) {
        const contact = await this.contactRepository.findOne({ where: { id: contactId, isActive: true } });
        if (!contact) {
            throw new common_1.NotFoundException(`Contact ${contactId} not found.`);
        }
        contact.isActive = false;
        contact.updatedBy = userId;
        await this.contactRepository.save(contact);
    }
    async findContracts(clientId) {
        await this.findOne(clientId);
        return this.contractRepository.find({ where: { clientId, isActive: true }, order: { createdAt: 'DESC' } });
    }
    async addContract(clientId, dto, userId) {
        await this.findOne(clientId);
        const existing = await this.contractRepository.findOne({ where: { contractNumber: dto.contractNumber } });
        if (existing) {
            throw new common_1.ConflictException(`Contract number ${dto.contractNumber} already exists.`);
        }
        const contract = this.contractRepository.create({
            clientId,
            contractNumber: dto.contractNumber,
            title: dto.title,
            description: dto.description ?? null,
            signedDate: dto.signedDate ?? null,
            effectiveFrom: dto.effectiveFrom,
            effectiveTo: dto.effectiveTo ?? null,
            value: dto.value ?? null,
            currency: dto.currency ?? 'INR',
            status: 'DRAFT',
            terms: dto.terms ?? null,
            documentUrl: dto.documentUrl ?? null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.contractRepository.save(contract);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'CLIENT_CONTRACT_CREATED',
            entityType: 'CLIENT',
            entityId: clientId,
            userId,
            remarks: `Added contract ${saved.contractNumber} - ${saved.title}`,
        });
        return saved;
    }
    async updateContract(contractId, dto, userId) {
        const contract = await this.contractRepository.findOne({ where: { id: contractId, isActive: true } });
        if (!contract) {
            throw new common_1.NotFoundException(`Contract ${contractId} not found.`);
        }
        if (dto.title !== undefined)
            contract.title = dto.title;
        if (dto.description !== undefined)
            contract.description = dto.description;
        if (dto.signedDate !== undefined)
            contract.signedDate = dto.signedDate;
        if (dto.effectiveFrom !== undefined)
            contract.effectiveFrom = dto.effectiveFrom;
        if (dto.effectiveTo !== undefined)
            contract.effectiveTo = dto.effectiveTo;
        if (dto.value !== undefined)
            contract.value = dto.value;
        if (dto.currency !== undefined)
            contract.currency = dto.currency;
        if (dto.status !== undefined)
            contract.status = dto.status;
        if (dto.terms !== undefined)
            contract.terms = dto.terms;
        if (dto.documentUrl !== undefined)
            contract.documentUrl = dto.documentUrl;
        contract.updatedBy = userId;
        const saved = await this.contractRepository.save(contract);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'CLIENT_CONTRACT_UPDATED',
            entityType: 'CLIENT',
            entityId: contract.clientId,
            userId,
            remarks: `Updated contract ${saved.contractNumber}`,
        });
        return saved;
    }
    async removeContract(contractId, userId) {
        const contract = await this.contractRepository.findOne({ where: { id: contractId, isActive: true } });
        if (!contract) {
            throw new common_1.NotFoundException(`Contract ${contractId} not found.`);
        }
        contract.isActive = false;
        contract.updatedBy = userId;
        await this.contractRepository.save(contract);
    }
    async findBilling(clientId) {
        await this.findOne(clientId);
        return this.billingRepository.findOne({ where: { clientId, isActive: true } });
    }
    async upsertBilling(clientId, dto, userId) {
        await this.findOne(clientId);
        let billing = await this.billingRepository.findOne({ where: { clientId } });
        if (!billing) {
            billing = this.billingRepository.create({
                clientId,
                paymentTerms: dto.paymentTerms ?? 'NET30',
                currency: dto.currency ?? 'INR',
                taxIdentifier: dto.taxIdentifier ?? null,
                invoiceCycle: dto.invoiceCycle ?? 'MONTHLY',
                billingAddress: dto.billingAddress ?? '',
                bankAccount: dto.bankAccount ?? null,
                bankName: dto.bankName ?? null,
                ifscCode: dto.ifscCode ?? null,
                notes: dto.notes ?? null,
                createdBy: userId,
                updatedBy: userId,
            });
        }
        else {
            if (dto.paymentTerms !== undefined)
                billing.paymentTerms = dto.paymentTerms;
            if (dto.currency !== undefined)
                billing.currency = dto.currency;
            if (dto.taxIdentifier !== undefined)
                billing.taxIdentifier = dto.taxIdentifier;
            if (dto.invoiceCycle !== undefined)
                billing.invoiceCycle = dto.invoiceCycle;
            if (dto.billingAddress !== undefined)
                billing.billingAddress = dto.billingAddress;
            if (dto.bankAccount !== undefined)
                billing.bankAccount = dto.bankAccount;
            if (dto.bankName !== undefined)
                billing.bankName = dto.bankName;
            if (dto.ifscCode !== undefined)
                billing.ifscCode = dto.ifscCode;
            if (dto.notes !== undefined)
                billing.notes = dto.notes;
            billing.updatedBy = userId;
        }
        const saved = await this.billingRepository.save(billing);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'CLIENT_BILLING_UPDATED',
            entityType: 'CLIENT',
            entityId: clientId,
            userId,
            remarks: `Updated billing for client ${clientId}`,
        });
        return saved;
    }
};
exports.ClientService = ClientService;
exports.ClientService = ClientService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(client_entity_1.ClientEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(client_configuration_entity_1.ClientConfigurationEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(client_contact_entity_1.ClientContactEntity)),
    __param(3, (0, typeorm_1.InjectRepository)(client_contract_entity_1.ClientContractEntity)),
    __param(4, (0, typeorm_1.InjectRepository)(client_billing_entity_1.ClientBillingEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        audit_service_1.AuditService])
], ClientService);
//# sourceMappingURL=client.service.js.map
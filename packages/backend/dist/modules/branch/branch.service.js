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
exports.BranchService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const XLSX = require("xlsx");
const branch_entity_1 = require("./branch.entity");
const branch_contact_entity_1 = require("./branch-contact.entity");
const branch_document_entity_1 = require("./branch-document.entity");
const client_service_1 = require("../client/client.service");
const zone_entity_1 = require("../zone/zone.entity");
const geo_entities_1 = require("../geo/geo.entities");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let BranchService = class BranchService {
    branchRepository;
    contactRepository;
    documentRepository;
    zoneRepository;
    stateRepository;
    districtRepository;
    cityRepository;
    clientService;
    auditService;
    constructor(branchRepository, contactRepository, documentRepository, zoneRepository, stateRepository, districtRepository, cityRepository, clientService, auditService) {
        this.branchRepository = branchRepository;
        this.contactRepository = contactRepository;
        this.documentRepository = documentRepository;
        this.zoneRepository = zoneRepository;
        this.stateRepository = stateRepository;
        this.districtRepository = districtRepository;
        this.cityRepository = cityRepository;
        this.clientService = clientService;
        this.auditService = auditService;
    }
    async create(dto, userId) {
        await this.validateGeography(dto.state, dto.district, dto.city);
        if (dto.zoneId) {
            const zone = await this.zoneRepository.findOne({ where: { id: dto.zoneId } });
            if (!zone) {
                throw new common_1.BadRequestException(`Zone ${dto.zoneId} not found.`);
            }
        }
        let location = null;
        if (dto.latitude && dto.longitude) {
            location = { type: 'Point', coordinates: [dto.longitude, dto.latitude] };
        }
        const branch = this.branchRepository.create({
            branchCode: dto.branchCode,
            solId: dto.solId ?? null,
            name: dto.name,
            address: dto.address,
            state: dto.state,
            district: dto.district,
            city: dto.city,
            pincode: dto.pincode ?? null,
            region: dto.region ?? null,
            territory: dto.territory ?? null,
            zoneId: dto.zoneId ?? null,
            branchType: dto.branchType ?? null,
            phone: dto.phone ?? null,
            email: dto.email ?? null,
            managerName: dto.managerName ?? null,
            openingDate: dto.openingDate ?? null,
            lastAuditDate: dto.lastAuditDate ?? null,
            operatingHours: dto.operatingHours ?? null,
            latitude: dto.latitude ?? null,
            longitude: dto.longitude ?? null,
            location,
            clientId: dto.clientId ?? null,
            riskScore: dto.riskScore ?? 0,
            riskCategory: dto.riskCategory ?? null,
            complexity: dto.complexity ?? 'STANDARD',
            estimatedDurationHours: dto.estimatedDurationHours ?? 8.00,
            requiredCompetencies: dto.requiredCompetencies ?? null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.branchRepository.save(branch);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'BRANCH_CREATED',
            entityType: 'BRANCH',
            entityId: saved.id,
            userId,
            remarks: `Created branch ${saved.name} (${saved.branchCode})`,
        });
        return saved;
    }
    async findOne(id) {
        const branch = await this.branchRepository.findOne({
            where: { id, isActive: true },
            relations: ['contacts', 'documents'],
        });
        if (!branch) {
            throw new common_1.NotFoundException(`Branch ${id} not found.`);
        }
        return branch;
    }
    async findAll(page = 1, limit = 20, clientId, region, zoneId) {
        const query = this.branchRepository.createQueryBuilder('branch')
            .where('branch.is_active = :isActive', { isActive: true });
        if (clientId)
            query.andWhere('branch.client_id = :clientId', { clientId });
        if (region)
            query.andWhere('branch.region = :region', { region });
        if (zoneId)
            query.andWhere('branch.zone_id = :zoneId', { zoneId });
        const [branches, total] = await query
            .orderBy('branch.name', 'ASC')
            .take(limit)
            .skip((page - 1) * limit)
            .getManyAndCount();
        return { branches, total };
    }
    async update(id, dto, userId) {
        const branch = await this.findOne(id);
        if (dto.state !== undefined || dto.district !== undefined || dto.city !== undefined) {
            await this.validateGeography(dto.state ?? branch.state, dto.district ?? branch.district, dto.city ?? branch.city);
        }
        if (dto.zoneId !== undefined && dto.zoneId !== null) {
            const zone = await this.zoneRepository.findOne({ where: { id: dto.zoneId } });
            if (!zone)
                throw new common_1.BadRequestException(`Zone ${dto.zoneId} not found.`);
        }
        let location = branch.location;
        const lat = dto.latitude ?? branch.latitude;
        const lng = dto.longitude ?? branch.longitude;
        if (lat && lng) {
            location = { type: 'Point', coordinates: [lng, lat] };
        }
        if (dto.branchCode !== undefined)
            branch.branchCode = dto.branchCode;
        if (dto.solId !== undefined)
            branch.solId = dto.solId;
        if (dto.name !== undefined)
            branch.name = dto.name;
        if (dto.address !== undefined)
            branch.address = dto.address;
        if (dto.state !== undefined)
            branch.state = dto.state;
        if (dto.district !== undefined)
            branch.district = dto.district;
        if (dto.city !== undefined)
            branch.city = dto.city;
        if (dto.pincode !== undefined)
            branch.pincode = dto.pincode;
        if (dto.region !== undefined)
            branch.region = dto.region;
        if (dto.territory !== undefined)
            branch.territory = dto.territory;
        if (dto.zoneId !== undefined)
            branch.zoneId = dto.zoneId;
        if (dto.branchType !== undefined)
            branch.branchType = dto.branchType;
        if (dto.phone !== undefined)
            branch.phone = dto.phone;
        if (dto.email !== undefined)
            branch.email = dto.email;
        if (dto.managerName !== undefined)
            branch.managerName = dto.managerName;
        if (dto.openingDate !== undefined)
            branch.openingDate = dto.openingDate;
        if (dto.lastAuditDate !== undefined)
            branch.lastAuditDate = dto.lastAuditDate;
        if (dto.operatingHours !== undefined)
            branch.operatingHours = dto.operatingHours;
        if (dto.latitude !== undefined)
            branch.latitude = dto.latitude;
        if (dto.longitude !== undefined)
            branch.longitude = dto.longitude;
        if (dto.clientId !== undefined)
            branch.clientId = dto.clientId;
        if (dto.riskScore !== undefined)
            branch.riskScore = dto.riskScore;
        if (dto.riskCategory !== undefined)
            branch.riskCategory = dto.riskCategory;
        if (dto.complexity !== undefined)
            branch.complexity = dto.complexity;
        if (dto.estimatedDurationHours !== undefined)
            branch.estimatedDurationHours = dto.estimatedDurationHours;
        if (dto.requiredCompetencies !== undefined)
            branch.requiredCompetencies = dto.requiredCompetencies;
        branch.location = location;
        branch.updatedBy = userId;
        const saved = await this.branchRepository.save(branch);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'BRANCH_UPDATED',
            entityType: 'BRANCH',
            entityId: saved.id,
            userId,
            remarks: `Updated branch ${saved.name} (${saved.branchCode})`,
        });
        return saved;
    }
    async remove(id, userId) {
        const branch = await this.findOne(id);
        branch.isActive = false;
        branch.updatedBy = userId;
        await this.branchRepository.save(branch);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'BRANCH_DELETED',
            entityType: 'BRANCH',
            entityId: id,
            userId,
            remarks: `Soft deleted branch ${branch.name}`,
        });
    }
    async findContacts(branchId) {
        await this.findOne(branchId);
        return this.contactRepository.find({ where: { branchId, isActive: true } });
    }
    async addContact(branchId, dto, userId) {
        await this.findOne(branchId);
        if (dto.isPrimary) {
            await this.contactRepository.update({ branchId, isPrimary: true }, { isPrimary: false });
        }
        const contact = this.contactRepository.create({
            branchId,
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
            eventType: 'BRANCH_CONTACT_CREATED',
            entityType: 'BRANCH',
            entityId: branchId,
            userId,
            remarks: `Added contact ${saved.name} to branch`,
        });
        return saved;
    }
    async updateContact(contactId, dto, userId) {
        const contact = await this.contactRepository.findOne({ where: { id: contactId, isActive: true } });
        if (!contact) {
            throw new common_1.NotFoundException(`Contact ${contactId} not found.`);
        }
        if (dto.isPrimary) {
            await this.contactRepository.update({ branchId: contact.branchId, isPrimary: true }, { isPrimary: false });
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
    async findDocuments(branchId) {
        await this.findOne(branchId);
        return this.documentRepository.find({ where: { branchId, isActive: true }, order: { createdAt: 'DESC' } });
    }
    async addDocument(branchId, dto, userId) {
        await this.findOne(branchId);
        const doc = this.documentRepository.create({
            branchId,
            fileName: dto.fileName,
            filePath: dto.filePath,
            fileSize: dto.fileSize,
            mimeType: dto.mimeType ?? null,
            category: dto.category,
            remarks: dto.remarks ?? null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.documentRepository.save(doc);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'BRANCH_DOCUMENT_CREATED',
            entityType: 'BRANCH',
            entityId: branchId,
            userId,
            remarks: `Added document ${saved.fileName} to branch`,
        });
        return saved;
    }
    async removeDocument(documentId, userId) {
        const doc = await this.documentRepository.findOne({ where: { id: documentId, isActive: true } });
        if (!doc) {
            throw new common_1.NotFoundException(`Document ${documentId} not found.`);
        }
        doc.isActive = false;
        doc.updatedBy = userId;
        await this.documentRepository.save(doc);
    }
    async importExcel(fileBuffer, clientId, userId) {
        const client = await this.clientService.findOne(clientId);
        const mapping = client.configuration?.importMapping;
        if (!mapping || Object.keys(mapping).length === 0) {
            throw new common_1.BadRequestException('Client import mappings are not configured.');
        }
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet);
        const errors = [];
        let importedCount = 0;
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            const rowNum = index + 2;
            try {
                const branchCode = String(row[mapping['branchCode'] || 'Branch Code'] || '').trim();
                const solId = String(row[mapping['solId'] || 'SOL ID'] || '').trim();
                const name = String(row[mapping['name'] || 'Branch Name'] || '').trim();
                const address = String(row[mapping['address'] || 'Address'] || '').trim();
                const state = String(row[mapping['state'] || 'State'] || '').trim();
                const district = String(row[mapping['district'] || 'District'] || '').trim();
                const city = String(row[mapping['city'] || 'City'] || '').trim();
                const pincode = String(row[mapping['pincode'] || 'Pincode'] || '').trim();
                const latitude = parseFloat(row[mapping['latitude'] || 'Latitude']);
                const longitude = parseFloat(row[mapping['longitude'] || 'Longitude']);
                if (!branchCode || !name || !address || !state || !district || !city) {
                    errors.push(`Row ${rowNum}: Missing required fields`);
                    continue;
                }
                try {
                    await this.validateGeography(state, district, city);
                }
                catch (geoErr) {
                    errors.push(`Row ${rowNum}: Geography validation failed - ${geoErr.message}`);
                    continue;
                }
                const existing = await this.branchRepository.findOne({
                    where: { branchCode, clientId, isActive: true },
                });
                if (existing) {
                    existing.name = name;
                    existing.address = address;
                    existing.state = state;
                    existing.district = district;
                    existing.city = city;
                    existing.pincode = pincode || null;
                    existing.latitude = isNaN(latitude) ? null : latitude;
                    existing.longitude = isNaN(longitude) ? null : longitude;
                    existing.updatedBy = userId;
                    if (!isNaN(latitude) && !isNaN(longitude)) {
                        existing.location = { type: 'Point', coordinates: [longitude, latitude] };
                    }
                    await this.branchRepository.save(existing);
                }
                else {
                    const branch = this.branchRepository.create({
                        branchCode,
                        solId: solId || null,
                        name,
                        address,
                        state,
                        district,
                        city,
                        pincode: pincode || null,
                        latitude: isNaN(latitude) ? null : latitude,
                        longitude: isNaN(longitude) ? null : longitude,
                        clientId,
                        location: (!isNaN(latitude) && !isNaN(longitude)) ? { type: 'Point', coordinates: [longitude, latitude] } : null,
                        createdBy: userId,
                        updatedBy: userId,
                    });
                    await this.branchRepository.save(branch);
                }
                importedCount++;
            }
            catch (err) {
                errors.push(`Row ${rowNum}: Unexpected parse error - ${err.message}`);
            }
        }
        if (importedCount > 0) {
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.OPERATIONAL,
                eventType: 'BRANCHES_BULK_IMPORT',
                entityType: 'CLIENT',
                entityId: clientId,
                userId,
                remarks: `Bulk imported/updated ${importedCount} branches. Errors: ${errors.length}`,
            });
        }
        return { importedCount, errors };
    }
    async validateGeography(state, district, city) {
        const stateEntity = await this.stateRepository.findOne({ where: { name: state } });
        if (!stateEntity) {
            throw new Error(`State '${state}' not found in master reference data.`);
        }
        const districtEntity = await this.districtRepository.findOne({
            where: { name: district, stateId: stateEntity.id },
        });
        if (!districtEntity) {
            throw new Error(`District '${district}' not found under state '${state}'.`);
        }
        const cityEntity = await this.cityRepository.findOne({
            where: { name: city, districtId: districtEntity.id },
        });
        if (!cityEntity) {
            throw new Error(`City '${city}' not found under district '${district}'.`);
        }
    }
};
exports.BranchService = BranchService;
exports.BranchService = BranchService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(branch_entity_1.BranchEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(branch_contact_entity_1.BranchContactEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(branch_document_entity_1.BranchDocumentEntity)),
    __param(3, (0, typeorm_1.InjectRepository)(zone_entity_1.ZoneEntity)),
    __param(4, (0, typeorm_1.InjectRepository)(geo_entities_1.GeoStateEntity)),
    __param(5, (0, typeorm_1.InjectRepository)(geo_entities_1.GeoDistrictEntity)),
    __param(6, (0, typeorm_1.InjectRepository)(geo_entities_1.GeoCityEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        client_service_1.ClientService,
        audit_service_1.AuditService])
], BranchService);
//# sourceMappingURL=branch.service.js.map
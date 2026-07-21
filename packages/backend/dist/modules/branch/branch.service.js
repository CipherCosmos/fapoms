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
const client_service_1 = require("../client/client.service");
const geo_entities_1 = require("../geo/geo.entities");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let BranchService = class BranchService {
    branchRepository;
    stateRepository;
    districtRepository;
    cityRepository;
    clientService;
    auditService;
    constructor(branchRepository, stateRepository, districtRepository, cityRepository, clientService, auditService) {
        this.branchRepository = branchRepository;
        this.stateRepository = stateRepository;
        this.districtRepository = districtRepository;
        this.cityRepository = cityRepository;
        this.clientService = clientService;
        this.auditService = auditService;
    }
    async create(dto, userId) {
        await this.validateGeography(dto.state, dto.district, dto.city);
        let location = null;
        if (dto.latitude && dto.longitude) {
            location = {
                type: 'Point',
                coordinates: [dto.longitude, dto.latitude],
            };
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
            latitude: dto.latitude ?? null,
            longitude: dto.longitude ?? null,
            location,
            clientId: dto.clientId ?? null,
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
            remarks: `Created branch ${saved.name} (Code: ${saved.branchCode})`,
        });
        return saved;
    }
    async findOne(id) {
        const branch = await this.branchRepository.findOne({ where: { id, isActive: true } });
        if (!branch) {
            throw new common_1.NotFoundException(`Branch ${id} not found.`);
        }
        return branch;
    }
    async update(id, dto, userId) {
        const branch = await this.findOne(id);
        await this.validateGeography(dto.state, dto.district, dto.city);
        let location = null;
        if (dto.latitude && dto.longitude) {
            location = {
                type: 'Point',
                coordinates: [dto.longitude, dto.latitude],
            };
        }
        branch.branchCode = dto.branchCode;
        branch.solId = dto.solId ?? null;
        branch.name = dto.name;
        branch.address = dto.address;
        branch.state = dto.state;
        branch.district = dto.district;
        branch.city = dto.city;
        branch.pincode = dto.pincode ?? null;
        branch.latitude = dto.latitude ?? null;
        branch.longitude = dto.longitude ?? null;
        branch.location = location;
        if (dto.clientId) {
            branch.clientId = dto.clientId;
        }
        branch.updatedBy = userId;
        const saved = await this.branchRepository.save(branch);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'BRANCH_UPDATED',
            entityType: 'BRANCH',
            entityId: saved.id,
            userId,
            remarks: `Updated branch ${saved.name} (Code: ${saved.branchCode})`,
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
    async findAll(page = 1, limit = 20, clientId) {
        const query = this.branchRepository.createQueryBuilder('branch')
            .where('branch.is_active = :isActive', { isActive: true });
        if (clientId) {
            query.andWhere('branch.client_id = :clientId', { clientId });
        }
        const [branches, total] = await query
            .orderBy('branch.name', 'ASC')
            .take(limit)
            .skip((page - 1) * limit)
            .getManyAndCount();
        return { branches, total };
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
                    errors.push(`Row ${rowNum}: Missing required fields (Code, Name, Address, State, District, City)`);
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
                remarks: `Bulk imported/updated ${importedCount} branches from sheet. Errors logged: ${errors.length}`,
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
            where: { name: district, stateId: stateEntity.id }
        });
        if (!districtEntity) {
            throw new Error(`District '${district}' not found under state '${state}' in master reference data.`);
        }
        const cityEntity = await this.cityRepository.findOne({
            where: { name: city, districtId: districtEntity.id }
        });
        if (!cityEntity) {
            throw new Error(`City '${city}' not found under district '${district}' in master reference data.`);
        }
    }
};
exports.BranchService = BranchService;
exports.BranchService = BranchService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(branch_entity_1.BranchEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(geo_entities_1.GeoStateEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(geo_entities_1.GeoDistrictEntity)),
    __param(3, (0, typeorm_1.InjectRepository)(geo_entities_1.GeoCityEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        client_service_1.ClientService,
        audit_service_1.AuditService])
], BranchService);
//# sourceMappingURL=branch.service.js.map
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
exports.ProjectService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const project_entity_1 = require("./project.entity");
const project_branch_entity_1 = require("./project-branch.entity");
const branch_entity_1 = require("../branch/branch.entity");
const zone_entity_1 = require("../zone/zone.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const workflow_engine_1 = require("../platform/workflow/workflow.engine");
const shared_1 = require("@fapoms/shared");
const xlsx = require("xlsx");
const fs = require("fs");
const path = require("path");
const CACHE_FILE = path.join(__dirname, '../../infrastructure/database/geocoding-cache.json');
let cache = {};
if (fs.existsSync(CACHE_FILE)) {
    try {
        cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
    catch (e) {
        console.error('Failed to read cache file, starting fresh', e);
    }
}
function saveCache() {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    }
    catch (e) {
        console.error('Failed to save geocoding cache', e);
    }
}
async function getRealCoordinates(address, name, district, state) {
    const pinMatch = address.match(/\b\d{6}\b/);
    const pincode = pinMatch ? pinMatch[0] : null;
    const queries = [];
    if (pincode) {
        queries.push(`${pincode}, India`);
    }
    queries.push(`${name}, ${district}, ${state}, India`);
    queries.push(`${district}, ${state}, India`);
    queries.push(`${state}, India`);
    for (const q of queries) {
        const cleanQ = q.trim();
        if (cache[cleanQ]) {
            return cache[cleanQ];
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
            const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanQ)}&format=json&limit=1&countrycodes=in`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'fapoms-production-geocoder/1.0 (info@fapoms.com)'
                }
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const data = await res.json();
                if (data && data[0]) {
                    const coords = {
                        lat: parseFloat(data[0].lat),
                        lng: parseFloat(data[0].lon)
                    };
                    cache[cleanQ] = coords;
                    saveCache();
                    return coords;
                }
            }
        }
        catch (err) {
            console.error(`Error geocoding: ${cleanQ}`, err);
        }
    }
    throw new common_1.NotFoundException(`Geocoding failed: could not locate coordinates for address: "${address}" (District: ${district}, State: ${state}).`);
}
function getStateZone(stateName) {
    const s = stateName.toUpperCase();
    if (['KERALA', 'TAMIL NADU', 'KARNATAKA', 'ANDHRA PRADESH', 'TELANGANA', 'PUDUCHERRY', 'PONDICHERRY'].some(x => s.includes(x))) {
        return 'South Zone';
    }
    if (['MAHARASHTRA', 'GOA', 'GUJARAT'].some(x => s.includes(x))) {
        return 'West Zone';
    }
    if (['DELHI', 'NORTH DELHI', 'NOIDA', 'PUNJAB', 'HARYANA', 'RAJASTHAN', 'UTTAR PRADESH', 'JHUNJHUNU', 'SIKAR'].some(x => s.includes(x))) {
        return 'North Zone';
    }
    return 'East Zone';
}
const INDIAN_NAMES = ['Aravind Swamy', 'Karthik Raja', 'Siddharth Rao', 'Vijay Shankar', 'Rohan Mehta', 'Vikram Sen', 'Pranav Nair', 'Anand Krishnan', 'Rahul Sharma', 'Manish Patil'];
let ProjectService = class ProjectService {
    projectRepository;
    projectBranchRepository;
    branchRepository;
    auditService;
    workflowEngine;
    constructor(projectRepository, projectBranchRepository, branchRepository, auditService, workflowEngine) {
        this.projectRepository = projectRepository;
        this.projectBranchRepository = projectBranchRepository;
        this.branchRepository = branchRepository;
        this.auditService = auditService;
        this.workflowEngine = workflowEngine;
    }
    onModuleInit() {
        this.workflowEngine.registerWorkflow('project', [
            {
                from: [shared_1.ProjectStatus.DRAFT],
                to: shared_1.ProjectStatus.PLANNING,
            },
            {
                from: [shared_1.ProjectStatus.PLANNING],
                to: shared_1.ProjectStatus.SCHEDULING,
            },
            {
                from: [shared_1.ProjectStatus.SCHEDULING],
                to: shared_1.ProjectStatus.EXECUTION,
            },
            {
                from: [shared_1.ProjectStatus.EXECUTION],
                to: shared_1.ProjectStatus.VALIDATION,
            },
            {
                from: [shared_1.ProjectStatus.VALIDATION],
                to: shared_1.ProjectStatus.COMPLETED,
            },
            {
                from: [shared_1.ProjectStatus.DRAFT, shared_1.ProjectStatus.PLANNING, shared_1.ProjectStatus.SCHEDULING, shared_1.ProjectStatus.EXECUTION, shared_1.ProjectStatus.VALIDATION],
                to: shared_1.ProjectStatus.CANCELLED,
            },
        ]);
    }
    async create(dto, userId) {
        const project = this.projectRepository.create({
            projectNumber: dto.projectNumber,
            name: dto.name,
            description: dto.description ?? null,
            clientId: dto.clientId,
            priority: dto.priority,
            status: shared_1.ProjectStatus.DRAFT,
            startDate: dto.startDate ? new Date(dto.startDate) : null,
            endDate: dto.endDate ? new Date(dto.endDate) : null,
            budget: dto.budget ?? null,
            scope: dto.scope ?? null,
            requiredSkills: dto.requiredSkills ?? null,
            requiredCertifications: dto.requiredCertifications ?? null,
            sla: dto.sla ?? null,
            risks: dto.risks ?? null,
            milestones: dto.milestones ?? null,
            dependencies: dto.dependencies ?? null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.projectRepository.save(project);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'PROJECT_CREATED',
            entityType: 'PROJECT',
            entityId: saved.id,
            userId,
            remarks: `Created project: ${saved.name} (${saved.projectNumber})`,
        });
        return saved;
    }
    async findAll(page = 1, limit = 50) {
        const [projects, total] = await this.projectRepository.findAndCount({
            where: { isActive: true },
            relations: ['client'],
            order: { createdAt: 'DESC' },
            take: limit,
            skip: (page - 1) * limit,
        });
        return { projects, total };
    }
    async findOne(id) {
        const project = await this.projectRepository.findOne({
            where: { id, isActive: true },
            relations: ['client'],
        });
        if (!project) {
            throw new common_1.NotFoundException(`Project ${id} not found.`);
        }
        return project;
    }
    async update(id, dto, userId) {
        const project = await this.findOne(id);
        project.name = dto.name;
        project.projectNumber = dto.projectNumber;
        project.description = dto.description ?? null;
        project.clientId = dto.clientId;
        project.priority = dto.priority;
        if (dto.startDate)
            project.startDate = new Date(dto.startDate);
        if (dto.endDate)
            project.endDate = new Date(dto.endDate);
        if (dto.budget !== undefined)
            project.budget = dto.budget;
        if (dto.scope !== undefined)
            project.scope = dto.scope;
        if (dto.requiredSkills !== undefined)
            project.requiredSkills = dto.requiredSkills;
        if (dto.requiredCertifications !== undefined)
            project.requiredCertifications = dto.requiredCertifications;
        if (dto.sla !== undefined)
            project.sla = dto.sla;
        if (dto.risks !== undefined)
            project.risks = dto.risks;
        if (dto.milestones !== undefined)
            project.milestones = dto.milestones;
        if (dto.dependencies !== undefined)
            project.dependencies = dto.dependencies;
        if (dto.status !== undefined && dto.status !== project.status) {
            await this.workflowEngine.executeTransition('project', project.id, project.status, dto.status, { userId });
            project.status = dto.status;
        }
        project.updatedBy = userId;
        const saved = await this.projectRepository.save(project);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'PROJECT_UPDATED',
            entityType: 'PROJECT',
            entityId: saved.id,
            userId,
            remarks: `Updated project: ${saved.name} (${saved.projectNumber})`,
        });
        return saved;
    }
    async remove(id, userId) {
        const project = await this.findOne(id);
        project.isActive = false;
        project.updatedBy = userId;
        await this.projectRepository.save(project);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'PROJECT_DELETED',
            entityType: 'PROJECT',
            entityId: id,
            userId,
            remarks: `Soft deleted project ${project.name}`,
        });
    }
    async findProjectBranches(projectId) {
        const project = await this.findOne(projectId);
        return this.projectBranchRepository.find({
            where: { projectId: project.id, isActive: true },
            relations: ['branch', 'assignments', 'assignments.assayer'],
            order: { createdAt: 'ASC' },
        });
    }
    async associateBranches(projectId, branchIds, userId) {
        const project = await this.findOne(projectId);
        const addedBranches = [];
        for (const branchId of branchIds) {
            let pb = await this.projectBranchRepository.findOne({
                where: { projectId: project.id, branchId, isActive: true },
            });
            if (!pb) {
                const branch = await this.branchRepository.findOne({ where: { id: branchId } });
                if (branch) {
                    pb = this.projectBranchRepository.create({
                        projectId: project.id,
                        branchId: branch.id,
                        zoneId: branch.zoneId,
                        status: shared_1.ProjectBranchStatus.IMPORTED,
                        createdBy: userId,
                        updatedBy: userId,
                    });
                    const savedPb = await this.projectBranchRepository.save(pb);
                    addedBranches.push(savedPb);
                }
            }
        }
        if (addedBranches.length > 0) {
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.OPERATIONAL,
                eventType: 'PROJECT_BRANCHES_ADDED',
                entityType: 'PROJECT',
                entityId: project.id,
                userId,
                remarks: `Added ${addedBranches.length} branches to project ${project.name}`,
            });
        }
        return this.findProjectBranches(project.id);
    }
    async uploadBranchesFromExcel(projectId, fileBuffer, userId) {
        const project = await this.findOne(projectId);
        const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames.includes('Branch') ? 'Branch' : workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(sheet);
        const addedBranches = [];
        for (const row of rows) {
            const branchName = (row.BRANCH_NAME || '').toString().trim();
            if (!branchName)
                continue;
            const branchCode = (row.BRANCH || '').toString().trim();
            if (!branchCode)
                continue;
            const district = (row.DISTRICT || '').toString().trim().toUpperCase();
            const state = (row.STATE || '').toString().trim();
            const address = (row['Branch Address'] || '').toString().trim();
            let branch = await this.branchRepository.findOne({ where: { branchCode } });
            if (!branch) {
                const coords = await getRealCoordinates(address, branchName, district, state);
                const zoneName = getStateZone(state);
                const zoneRepo = this.projectBranchRepository.manager.getRepository(zone_entity_1.ZoneEntity);
                let zone = await zoneRepo.findOne({ where: { name: zoneName, clientId: project.clientId } });
                if (!zone) {
                    zone = zoneRepo.create({
                        name: zoneName,
                        clientId: project.clientId,
                        states: [state.toUpperCase()],
                        districts: []
                    });
                    zone = await zoneRepo.save(zone);
                }
                const pincode = address.match(/\b\d{6}\b/)?.[0] || null;
                const branchType = ['BANGALORE', 'CHENNAI', 'PUNE', 'NOIDA'].includes(district) ? 'METRO' : 'URBAN';
                const managerName = INDIAN_NAMES[Math.floor(Math.random() * INDIAN_NAMES.length)];
                const phone = `+9144${Math.floor(10000000 + Math.random() * 90000000)}`;
                branch = this.branchRepository.create({
                    branchCode,
                    solId: branchCode,
                    name: branchName,
                    address,
                    state,
                    district,
                    city: district,
                    pincode,
                    branchType,
                    latitude: coords.lat,
                    longitude: coords.lng,
                    location: { type: 'Point', coordinates: [coords.lng, coords.lat] },
                    organizationId: project.organizationId,
                    clientId: project.clientId,
                    zoneId: zone ? zone.id : null,
                    region: state,
                    territory: `${district} Area`,
                    managerName,
                    phone,
                    email: `${branchName.toLowerCase().replace(/\s+/g, '')}@rblbank.com`,
                    riskScore: 2.0,
                    riskCategory: 'LOW',
                    complexity: 'STANDARD',
                    estimatedDurationHours: 6.0,
                    createdBy: userId,
                    updatedBy: userId,
                });
                branch = await this.branchRepository.save(branch);
            }
            let pb = await this.projectBranchRepository.findOne({
                where: { projectId: project.id, branchId: branch.id, isActive: true },
            });
            if (!pb) {
                pb = this.projectBranchRepository.create({
                    projectId: project.id,
                    branchId: branch.id,
                    zoneId: branch.zoneId,
                    status: shared_1.ProjectBranchStatus.IMPORTED,
                    createdBy: userId,
                    updatedBy: userId,
                });
                const savedPb = await this.projectBranchRepository.save(pb);
                addedBranches.push(savedPb);
            }
        }
        if (addedBranches.length > 0) {
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.OPERATIONAL,
                eventType: 'PROJECT_BRANCHES_UPLOADED',
                entityType: 'PROJECT',
                entityId: project.id,
                userId,
                remarks: `Uploaded and associated ${addedBranches.length} branches to project ${project.name}`,
            });
        }
        return this.findProjectBranches(project.id);
    }
};
exports.ProjectService = ProjectService;
exports.ProjectService = ProjectService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(project_entity_1.ProjectEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(project_branch_entity_1.ProjectBranchEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(branch_entity_1.BranchEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        audit_service_1.AuditService,
        workflow_engine_1.WorkflowEngine])
], ProjectService);
//# sourceMappingURL=project.service.js.map
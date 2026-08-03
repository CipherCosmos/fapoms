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
const assessment_entity_1 = require("./assessment.entity");
const client_entity_1 = require("../client/client.entity");
const project_state_machine_1 = require("./project.state-machine");
const branch_service_1 = require("../branch/branch.service");
const project_query_service_1 = require("./project-query.service");
const branch_query_service_1 = require("../branch/branch-query.service");
const audit_service_1 = require("../../core/audit/audit.service");
const workflow_engine_1 = require("../platform/workflow/workflow.engine");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
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
let ProjectService = class ProjectService {
    projectRepository;
    projectBranchRepository;
    assessmentRepository;
    clientRepository;
    branchQueryService;
    branchService;
    auditService;
    workflowEngine;
    eventPublisher;
    projectQueryService;
    constructor(projectRepository, projectBranchRepository, assessmentRepository, clientRepository, branchQueryService, branchService, auditService, workflowEngine, eventPublisher, projectQueryService) {
        this.projectRepository = projectRepository;
        this.projectBranchRepository = projectBranchRepository;
        this.assessmentRepository = assessmentRepository;
        this.clientRepository = clientRepository;
        this.branchQueryService = branchQueryService;
        this.branchService = branchService;
        this.auditService = auditService;
        this.workflowEngine = workflowEngine;
        this.eventPublisher = eventPublisher;
        this.projectQueryService = projectQueryService;
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
                from: [
                    shared_1.ProjectStatus.DRAFT, shared_1.ProjectStatus.PLANNING, shared_1.ProjectStatus.SCHEDULING,
                    shared_1.ProjectStatus.EXECUTION, shared_1.ProjectStatus.VALIDATION, shared_1.ProjectStatus.ON_HOLD,
                ],
                to: shared_1.ProjectStatus.CANCELLED,
            },
            {
                from: [shared_1.ProjectStatus.SCHEDULING, shared_1.ProjectStatus.EXECUTION],
                to: shared_1.ProjectStatus.ON_HOLD,
            },
            {
                from: [shared_1.ProjectStatus.ON_HOLD],
                to: shared_1.ProjectStatus.SCHEDULING,
            },
            {
                from: [shared_1.ProjectStatus.ON_HOLD],
                to: shared_1.ProjectStatus.EXECUTION,
            },
            {
                from: [shared_1.ProjectStatus.COMPLETED],
                to: shared_1.ProjectStatus.ARCHIVED,
            },
        ]);
    }
    async create(dto, userId, organizationId) {
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
            organizationId: organizationId ?? null,
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
        this.eventPublisher.publish('project:created', {
            eventType: 'project:created',
            aggregateId: saved.id,
            userId,
            organizationId: saved.organizationId,
            payload: { id: saved.id, name: saved.name, projectNumber: saved.projectNumber, clientId: saved.clientId },
        });
        return saved;
    }
    async findAll(page = 1, limit = 50) {
        return this.projectQueryService.findAll(page, limit);
    }
    async findOne(id) {
        return this.projectQueryService.findOne(id);
    }
    async transition(id, targetStatus, userId, reason) {
        const project = await this.findOne(id);
        if (project.status === targetStatus) {
            throw new common_1.BadRequestException(`Project is already ${targetStatus}.`);
        }
        const moves = {
            [shared_1.ProjectStatus.PLANNING]: () => this.startProjectPlanning(id, userId),
            [shared_1.ProjectStatus.SCHEDULING]: () => this.readyProjectForScheduling(id, userId),
            [shared_1.ProjectStatus.EXECUTION]: () => this.startProjectExecution(id, userId),
            [shared_1.ProjectStatus.VALIDATION]: () => this.startProjectValidation(id, userId),
            [shared_1.ProjectStatus.COMPLETED]: () => this.completeProject(id, userId),
            [shared_1.ProjectStatus.CANCELLED]: () => this.cancelProject(id, userId),
            [shared_1.ProjectStatus.ON_HOLD]: () => this.holdProject(id, userId),
            [shared_1.ProjectStatus.ARCHIVED]: () => this.archiveProject(id, userId),
        };
        const move = moves[targetStatus];
        if (!move)
            throw new common_1.BadRequestException(`Unknown project status: ${targetStatus}`);
        await move();
        const updated = await this.findOne(id);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'PROJECT_STATUS_CHANGED',
            entityType: 'PROJECT',
            entityId: id,
            userId,
            remarks: reason
                ? `${project.status} → ${targetStatus}: ${reason}`
                : `${project.status} → ${targetStatus}`,
        });
        return updated;
    }
    async update(id, dto, userId) {
        const project = await this.findOne(id);
        if (dto.name !== undefined)
            project.name = dto.name;
        if (dto.projectNumber !== undefined)
            project.projectNumber = dto.projectNumber;
        if (dto.description !== undefined)
            project.description = dto.description ?? null;
        if (dto.clientId !== undefined)
            project.clientId = dto.clientId;
        if (dto.priority !== undefined)
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
            if (dto.status === shared_1.ProjectStatus.PLANNING) {
                await this.startProjectPlanning(project.id, userId);
            }
            else if (dto.status === shared_1.ProjectStatus.SCHEDULING) {
                await this.readyProjectForScheduling(project.id, userId);
            }
            else if (dto.status === shared_1.ProjectStatus.EXECUTION) {
                await this.startProjectExecution(project.id, userId);
            }
            else if (dto.status === shared_1.ProjectStatus.VALIDATION) {
                await this.startProjectValidation(project.id, userId);
            }
            else if (dto.status === shared_1.ProjectStatus.COMPLETED) {
                await this.completeProject(project.id, userId);
            }
            else if (dto.status === shared_1.ProjectStatus.CANCELLED) {
                await this.cancelProject(project.id, userId);
            }
            else if (dto.status === shared_1.ProjectStatus.ON_HOLD) {
                await this.holdProject(project.id, userId);
            }
            else if (dto.status === shared_1.ProjectStatus.ARCHIVED) {
                await this.archiveProject(project.id, userId);
            }
            else {
                throw new common_1.BadRequestException(`Invalid project status transition to ${dto.status}`);
            }
            const updatedProject = await this.findOne(id);
            project.status = updatedProject.status;
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
        this.eventPublisher.publish('project:updated', {
            eventType: 'project:updated',
            aggregateId: saved.id,
            userId,
            organizationId: saved.organizationId,
            payload: { id: saved.id, name: saved.name, status: saved.status },
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
        this.eventPublisher.publish('project:deleted', {
            eventType: 'project:deleted',
            aggregateId: id,
            userId,
            organizationId: project.organizationId,
            payload: { id, name: project.name, projectNumber: project.projectNumber },
        });
    }
    async findProjectBranches(projectId) {
        return this.projectQueryService.findProjectBranches(projectId);
    }
    async associateBranches(projectId, branchIds, userId) {
        const project = await this.findOne(projectId);
        const addedBranches = [];
        for (const branchId of branchIds) {
            let pb = await this.projectBranchRepository.findOne({
                where: { projectId: project.id, branchId, isActive: true },
            });
            if (!pb) {
                const branch = await this.branchQueryService.findOne(branchId);
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
                    const existingAsmt = await this.assessmentRepository.findOne({
                        where: { projectId: project.id, branchId: branch.id, isActive: true },
                    });
                    if (!existingAsmt) {
                        const asmt = this.assessmentRepository.create({
                            projectId: project.id,
                            branchId: branch.id,
                            zoneId: branch.zoneId,
                            status: shared_1.AssessmentStatus.PENDING_PLANNING,
                            createdBy: userId,
                            updatedBy: userId,
                        });
                        await this.assessmentRepository.save(asmt);
                    }
                }
            }
        }
        if (addedBranches.length > 0) {
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.OPERATIONAL,
                eventType: 'PROJECT_BRANCHES_ASSOCIATED',
                entityType: 'PROJECT',
                entityId: project.id,
                userId,
                remarks: `Associated ${addedBranches.length} branches with project ${project.name}`,
            });
        }
        return this.findProjectBranches(project.id);
    }
    async generateBranchTemplate(projectId) {
        const project = await this.findOne(projectId);
        const client = project.clientId
            ? await this.clientRepository.findOne({ where: { id: project.clientId } })
            : null;
        const headers = [
            'BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets',
            'Pincode', 'Latitude', 'Longitude',
            'Branch Manager', 'Branch Phone', 'Branch Email',
            'Risk Category', 'Complexity', 'Estimated Hours',
        ];
        const projectBranches = await this.projectBranchRepository.find({
            where: { projectId, isActive: true },
            relations: ['branch'],
        });
        const rows = projectBranches.map((pb) => ({
            BRANCH: pb.branch.branchCode,
            BRANCH_NAME: pb.branch.name,
            DISTRICT: pb.branch.district,
            STATE: pb.branch.state,
            'Branch Address': pb.branch.address || '',
            Packets: pb.packetCount ?? '',
            Pincode: pb.branch.pincode || '',
            Latitude: pb.branch.latitude ?? '',
            Longitude: pb.branch.longitude ?? '',
            'Branch Manager': pb.branch.managerName || '',
            'Branch Phone': pb.branch.phone || '',
            'Branch Email': pb.branch.email || '',
            'Risk Category': pb.branch.riskCategory || '',
            Complexity: pb.branch.complexity || '',
            'Estimated Hours': pb.branch.estimatedDurationHours ?? '',
        }));
        if (rows.length === 0) {
            rows.push(Object.fromEntries(headers.map((h) => [h, ''])));
        }
        const ws = xlsx.utils.json_to_sheet(rows, { header: headers });
        ws['!cols'] = headers.map((h) => ({ wch: h === 'Branch Address' ? 55 : Math.max(14, h.length + 4) }));
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Branch');
        const instructions = [
            { Field: 'BRANCH', Required: 'Yes', Description: 'Branch code from the client, e.g. 8 or BR-0010. Re-importing the same code updates that branch rather than creating a duplicate.' },
            { Field: 'BRANCH_NAME', Required: 'Yes', Description: 'Branch name, e.g. THENKURISSI.' },
            { Field: 'DISTRICT', Required: 'Yes', Description: 'District name — used to cluster nearby branches into one assayer-day and to compute travel.' },
            { Field: 'STATE', Required: 'Yes', Description: 'State name — used to apply state-specific public holidays when scheduling.' },
            { Field: 'Branch Address', Required: 'Yes', Description: 'Full address. Used to geocode the branch; a 6-digit pincode inside this text is detected automatically.' },
            { Field: 'Packets', Required: 'Yes', Description: 'Estimated packets to audit at this branch this cycle. Drives how long the audit takes, how many branches one assayer can cover in a day, and the coverage figure quoted to the client. Left blank, the system assumes a flat 6 hours and the plan will be wrong.' },
            { Field: 'Pincode', Required: 'No', Description: '6-digit pincode. Leave blank if it already appears in the address.' },
            { Field: 'Latitude', Required: 'No', Description: 'Decimal degrees, e.g. 10.7867. Supply with Longitude to skip geocoding entirely — faster on import and exact, instead of relying on an address lookup that can place the branch imprecisely or fail.' },
            { Field: 'Longitude', Required: 'No', Description: 'Decimal degrees, e.g. 76.6548. Must be supplied together with Latitude.' },
            { Field: 'Branch Manager', Required: 'No', Description: 'Contact name at the branch, shown to the assayer before the visit.' },
            { Field: 'Branch Phone', Required: 'No', Description: 'Branch contact number, shown to the assayer before the visit.' },
            { Field: 'Branch Email', Required: 'No', Description: 'Branch email for correspondence.' },
            { Field: 'Risk Category', Required: 'No', Description: 'LOW / MEDIUM / HIGH / CRITICAL. Higher-risk branches are preferentially matched to more experienced assayers.' },
            { Field: 'Complexity', Required: 'No', Description: 'SIMPLE / STANDARD / COMPLEX. Feeds the same matching, and the time allowance per branch.' },
            { Field: 'Estimated Hours', Required: 'No', Description: 'Override the audit duration for this branch. Normally leave blank — it is calculated from Packets, which stays accurate as packet counts change each cycle.' },
        ];
        const instrWs = xlsx.utils.json_to_sheet(instructions, { header: ['Field', 'Required', 'Description'] });
        instrWs['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 110 }];
        xlsx.utils.book_append_sheet(wb, instrWs, 'Instructions');
        return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    }
    async uploadBranchesFromExcel(projectId, fileBuffer, userId) {
        const project = await this.findOne(projectId);
        const client = project.clientId
            ? await this.clientRepository.findOne({ where: { id: project.clientId } })
            : null;
        const planningPrefs = client?.planningPreferences || {};
        const minutesPerPacket = Number(planningPrefs.minutesPerPacket) || 15;
        const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(worksheet);
        const addedBranches = [];
        for (const row of rows) {
            const branchName = (row['Branch Name'] || row.BRANCH_NAME || '').toString().trim();
            if (!branchName)
                continue;
            const branchCode = (row.BRANCH || row['Branch Code'] || '').toString().trim();
            if (!branchCode)
                continue;
            const district = (row.DISTRICT || '').toString().trim().toUpperCase();
            const state = (row.STATE || '').toString().trim();
            const address = (row['Branch Address'] || row.Address || '').toString().trim();
            const pincodeStr = (row.Pincode || '').toString().trim();
            const packetCount = parseInt(String(row.Packets ?? row.packet_count ?? ''), 10);
            const calculatedHours = !isNaN(packetCount) && packetCount > 0
                ? parseFloat(((packetCount * minutesPerPacket) / 60).toFixed(2))
                : null;
            const latRaw = parseFloat(String(row.Latitude ?? row.latitude ?? ''));
            const lngRaw = parseFloat(String(row.Longitude ?? row.longitude ?? ''));
            const suppliedCoords = Number.isFinite(latRaw) && Number.isFinite(lngRaw)
                ? { lat: latRaw, lng: lngRaw }
                : null;
            let branch = await this.branchQueryService.findOneByCode(branchCode);
            if (!branch) {
                const coords = suppliedCoords ?? await getRealCoordinates(address, branchName, district, state);
                const zoneName = getStateZone(state);
                const zone = await this.branchService.findOrCreateZone(zoneName, project.clientId, [state.toUpperCase()]);
                const pincode = pincodeStr || address.match(/\b\d{6}\b/)?.[0] || null;
                const branchType = ['BANGALORE', 'CHENNAI', 'PUNE', 'NOIDA'].includes(district) ? 'METRO' : 'URBAN';
                const managerName = (row['Branch Manager'] || '').toString().trim() || null;
                const phone = (row['Branch Phone'] || '').toString().trim() || null;
                branch = await this.branchService.registerImportedBranch({
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
                    email: (row['Branch Email'] || '').toString().trim() || null,
                    riskScore: 2.0,
                    riskCategory: (row['Risk Category'] || '').toString().trim().toUpperCase() || 'LOW',
                    complexity: (row.Complexity || '').toString().trim().toUpperCase() || 'STANDARD',
                    estimatedDurationHours: parseFloat(String(row['Estimated Hours'] ?? '')) || calculatedHours || 6.0,
                    createdBy: userId,
                    updatedBy: userId,
                }, userId);
            }
            else if (calculatedHours !== null) {
                await this.branchService.update(branch.id, { estimatedDurationHours: calculatedHours }, userId);
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
                    packetCount: !isNaN(packetCount) && packetCount > 0 ? packetCount : null,
                    createdBy: userId,
                    updatedBy: userId,
                });
                const savedPb = await this.projectBranchRepository.save(pb);
                addedBranches.push(savedPb);
                const existingAsmt = await this.assessmentRepository.findOne({
                    where: { projectId: project.id, branchId: branch.id, isActive: true },
                });
                if (!existingAsmt) {
                    const asmt = this.assessmentRepository.create({
                        projectId: project.id,
                        branchId: branch.id,
                        zoneId: branch.zoneId,
                        status: shared_1.AssessmentStatus.PENDING_PLANNING,
                        packetSize: !isNaN(packetCount) && packetCount > 0 ? packetCount : null,
                        createdBy: userId,
                        updatedBy: userId,
                    });
                    await this.assessmentRepository.save(asmt);
                }
            }
            else if (!isNaN(packetCount) && packetCount > 0) {
                pb.packetCount = packetCount;
                pb.updatedBy = userId;
                await this.projectBranchRepository.save(pb);
            }
        }
        return this.findProjectBranches(project.id);
    }
    async removeProjectBranch(projectId, projectBranchId, userId) {
        const pb = await this.projectBranchRepository.findOne({
            where: { id: projectBranchId, projectId, isActive: true },
        });
        if (pb) {
            pb.isActive = false;
            pb.updatedBy = userId;
            await this.projectBranchRepository.save(pb);
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.OPERATIONAL,
                eventType: 'PROJECT_BRANCH_REMOVED',
                entityType: 'PROJECT',
                entityId: projectId,
                userId,
                remarks: `Removed branch association link ${projectBranchId}`,
            });
        }
        return this.findProjectBranches(projectId);
    }
    async startProjectPlanning(id, userId, role = shared_1.SystemRole.SUPER_ADMINISTRATOR) {
        const project = await this.findOne(id);
        const prev = project.status;
        const next = shared_1.ProjectStatus.PLANNING;
        return this.workflowEngine.executeCommand('project', project.id, 'StartPlanningCommand', prev, next, userId, role, [shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER], async () => {
            const event = project_state_machine_1.ProjectStateMachine.startPlanning(project, userId);
            const saved = await this.projectRepository.save(project);
            this.eventPublisher.publish(event.constructor.name, event);
            return saved;
        });
    }
    async readyProjectForScheduling(id, userId, role = shared_1.SystemRole.SUPER_ADMINISTRATOR) {
        const project = await this.findOne(id);
        const prev = project.status;
        const next = shared_1.ProjectStatus.SCHEDULING;
        return this.workflowEngine.executeCommand('project', project.id, 'ReadyProjectForSchedulingCommand', prev, next, userId, role, [shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER], async () => {
            const event = project_state_machine_1.ProjectStateMachine.readyForScheduling(project, userId);
            const saved = await this.projectRepository.save(project);
            this.eventPublisher.publish(event.constructor.name, event);
            return saved;
        });
    }
    async startProjectExecution(id, userId, role = shared_1.SystemRole.SUPER_ADMINISTRATOR) {
        const project = await this.findOne(id);
        const prev = project.status;
        const next = shared_1.ProjectStatus.EXECUTION;
        return this.workflowEngine.executeCommand('project', project.id, 'StartProjectExecutionCommand', prev, next, userId, role, [shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER], async () => {
            const event = project_state_machine_1.ProjectStateMachine.startExecution(project, userId);
            const saved = await this.projectRepository.save(project);
            this.eventPublisher.publish(event.constructor.name, event);
            return saved;
        });
    }
    async startProjectValidation(id, userId, role = shared_1.SystemRole.SUPER_ADMINISTRATOR) {
        const project = await this.findOne(id);
        const prev = project.status;
        const next = shared_1.ProjectStatus.VALIDATION;
        return this.workflowEngine.executeCommand('project', project.id, 'StartProjectValidationCommand', prev, next, userId, role, [shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER], async () => {
            const event = project_state_machine_1.ProjectStateMachine.startValidation(project, userId);
            const saved = await this.projectRepository.save(project);
            this.eventPublisher.publish(event.constructor.name, event);
            return saved;
        });
    }
    async completeProject(id, userId, role = shared_1.SystemRole.SUPER_ADMINISTRATOR) {
        const project = await this.findOne(id);
        const prev = project.status;
        const next = shared_1.ProjectStatus.COMPLETED;
        return this.workflowEngine.executeCommand('project', project.id, 'CompleteProjectCommand', prev, next, userId, role, [shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER], async () => {
            const event = project_state_machine_1.ProjectStateMachine.completeProject(project, userId);
            const saved = await this.projectRepository.save(project);
            this.eventPublisher.publish(event.constructor.name, event);
            return saved;
        });
    }
    async cancelProject(id, userId, role = shared_1.SystemRole.SUPER_ADMINISTRATOR) {
        const project = await this.findOne(id);
        const prev = project.status;
        const next = shared_1.ProjectStatus.CANCELLED;
        return this.workflowEngine.executeCommand('project', project.id, 'CancelProjectCommand', prev, next, userId, role, [shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER], async () => {
            const event = project_state_machine_1.ProjectStateMachine.cancelProject(project, userId);
            const saved = await this.projectRepository.save(project);
            this.eventPublisher.publish(event.constructor.name, event);
            return saved;
        });
    }
    async holdProject(id, userId, role = shared_1.SystemRole.SUPER_ADMINISTRATOR) {
        const project = await this.findOne(id);
        const prev = project.status;
        const next = shared_1.ProjectStatus.ON_HOLD;
        return this.workflowEngine.executeCommand('project', project.id, 'HoldProjectCommand', prev, next, userId, role, [shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER], async () => {
            const event = project_state_machine_1.ProjectStateMachine.holdProject(project, userId);
            const saved = await this.projectRepository.save(project);
            this.eventPublisher.publish(event.constructor.name, event);
            return saved;
        });
    }
    async archiveProject(id, userId, role = shared_1.SystemRole.SUPER_ADMINISTRATOR) {
        const project = await this.findOne(id);
        const prev = project.status;
        const next = shared_1.ProjectStatus.ARCHIVED;
        return this.workflowEngine.executeCommand('project', project.id, 'ArchiveProjectCommand', prev, next, userId, role, [shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER], async () => {
            const event = project_state_machine_1.ProjectStateMachine.archiveProject(project, userId);
            const saved = await this.projectRepository.save(project);
            this.eventPublisher.publish(event.constructor.name, event);
            return saved;
        });
    }
    async getBranchHistory(projectBranchId) {
        const pb = await this.projectBranchRepository.findOne({
            where: { id: projectBranchId },
            relations: ['branch', 'project'],
        });
        if (!pb)
            throw new common_1.NotFoundException(`Project branch ${projectBranchId} not found.`);
        const rows = await this.projectBranchRepository.manager.query(`
      -- Branch status transitions
      SELECT 'STATUS' AS kind, ae.occurred_at AS at, ae.event_type AS title,
             ae.previous_state AS "from", ae.new_state AS "to", ae.remarks AS detail,
             COALESCE(ae.user_display_name,
                      NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
                      u.username) AS actor
      FROM audit_events ae
      LEFT JOIN users u ON u.id = ae.user_id
      WHERE ae.entity_type = 'PROJECT_BRANCH' AND ae.entity_id = $1

      UNION ALL
      -- Assignments offered / accepted / completed on this branch
      SELECT 'ASSIGNMENT', a.updated_at, 'Assignment ' || a.status::text,
             NULL, a.status::text, a.assignment_number,
             COALESCE(asr.display_name, 'unassigned')
      FROM assignments a
      LEFT JOIN assayers asr ON asr.id = a.assayer_id
      WHERE a.project_branch_id = $1 AND a.is_active = true

      UNION ALL
      -- Paperwork in and out
      SELECT 'DOCUMENT', d.updated_at, d.type::text || ' ' || d.status::text,
             NULL, d.status::text, d.file_name,
             COALESCE(NULLIF(TRIM(CONCAT_WS(' ', du.first_name, du.last_name)), ''), du.username)
      FROM documents d
      LEFT JOIN users du ON du.id = d.assigned_to_user_id
      WHERE d.project_branch_id = $1 AND d.is_active = true

      UNION ALL
      -- Validation / review outcome
      SELECT 'VALIDATION', ae2.occurred_at, ae2.event_type,
             ae2.previous_state, ae2.new_state, ae2.remarks,
             COALESCE(ae2.user_display_name,
                      NULLIF(TRIM(CONCAT_WS(' ', vu.first_name, vu.last_name)), ''),
                      vu.username)
      FROM audit_events ae2
      LEFT JOIN users vu ON vu.id = ae2.user_id
      WHERE ae2.entity_type = 'VALIDATION'
        AND ae2.entity_id IN (SELECT id FROM validation_cases WHERE project_branch_id = $1)

      ORDER BY at DESC
      `, [projectBranchId]);
        return {
            projectBranchId,
            branchName: pb.branch?.name ?? null,
            branchCode: pb.branch?.branchCode ?? null,
            projectName: pb.project?.name ?? null,
            currentStatus: pb.status,
            scheduledDate: pb.scheduledDate ?? null,
            packetCount: pb.packetCount ?? null,
            timeline: rows,
        };
    }
    async recordBranchTransition(pb, previousStatus, userId) {
        if (previousStatus === pb.status)
            return;
        try {
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.WORKFLOW,
                eventType: `PROJECT_BRANCH_${pb.status}`,
                entityType: 'PROJECT_BRANCH',
                entityId: pb.id,
                previousState: previousStatus,
                newState: pb.status,
                userId,
                remarks: `Branch moved ${previousStatus} → ${pb.status}`,
            });
        }
        catch (err) {
            console.warn(`Could not record branch transition for ${pb.id}: ${err?.message}`);
        }
    }
    async initiateBranchPlanning(projectBranchId, userId, manager) {
        const repo = manager ? manager.getRepository(project_branch_entity_1.ProjectBranchEntity) : this.projectBranchRepository;
        const pb = await repo.findOne({
            where: { id: projectBranchId, isActive: true },
        });
        if (!pb) {
            throw new common_1.NotFoundException(`Project branch link ${projectBranchId} not found.`);
        }
        const previousStatus = pb.status;
        const event = project_state_machine_1.ProjectBranchStateMachine.initiatePlanning(pb, userId);
        pb.updatedBy = userId;
        const saved = await repo.save(pb);
        await this.recordBranchTransition(saved, previousStatus, userId);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async confirmBranchAssignment(projectBranchId, userId, manager) {
        const repo = manager ? manager.getRepository(project_branch_entity_1.ProjectBranchEntity) : this.projectBranchRepository;
        const pb = await repo.findOne({
            where: { id: projectBranchId, isActive: true },
        });
        if (!pb) {
            throw new common_1.NotFoundException(`Project branch link ${projectBranchId} not found.`);
        }
        const previousStatus = pb.status;
        const event = project_state_machine_1.ProjectBranchStateMachine.confirmAssignment(pb, userId);
        pb.updatedBy = userId;
        const saved = await repo.save(pb);
        await this.recordBranchTransition(saved, previousStatus, userId);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async scheduleBranchAudit(projectBranchId, userId, manager) {
        const repo = manager ? manager.getRepository(project_branch_entity_1.ProjectBranchEntity) : this.projectBranchRepository;
        const pb = await repo.findOne({
            where: { id: projectBranchId, isActive: true },
        });
        if (!pb) {
            throw new common_1.NotFoundException(`Project branch link ${projectBranchId} not found.`);
        }
        const previousStatus = pb.status;
        const event = project_state_machine_1.ProjectBranchStateMachine.scheduleAudit(pb, userId);
        pb.updatedBy = userId;
        const saved = await repo.save(pb);
        await this.recordBranchTransition(saved, previousStatus, userId);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async completeBranchAudit(projectBranchId, userId, manager) {
        const repo = manager ? manager.getRepository(project_branch_entity_1.ProjectBranchEntity) : this.projectBranchRepository;
        const pb = await repo.findOne({
            where: { id: projectBranchId, isActive: true },
        });
        if (!pb) {
            throw new common_1.NotFoundException(`Project branch link ${projectBranchId} not found.`);
        }
        const previousStatus = pb.status;
        const event = project_state_machine_1.ProjectBranchStateMachine.completeAudit(pb, userId);
        pb.updatedBy = userId;
        const saved = await repo.save(pb);
        await this.recordBranchTransition(saved, previousStatus, userId);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async completeBranchValidation(projectBranchId, userId, manager) {
        const repo = manager ? manager.getRepository(project_branch_entity_1.ProjectBranchEntity) : this.projectBranchRepository;
        const pb = await repo.findOne({
            where: { id: projectBranchId, isActive: true },
        });
        if (!pb) {
            throw new common_1.NotFoundException(`Project branch link ${projectBranchId} not found.`);
        }
        const previousStatus = pb.status;
        const event = project_state_machine_1.ProjectBranchStateMachine.completeValidation(pb, userId);
        pb.updatedBy = userId;
        const saved = await repo.save(pb);
        await this.recordBranchTransition(saved, previousStatus, userId);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async closeBranchProject(projectBranchId, userId, manager) {
        const repo = manager ? manager.getRepository(project_branch_entity_1.ProjectBranchEntity) : this.projectBranchRepository;
        const pb = await repo.findOne({
            where: { id: projectBranchId, isActive: true },
        });
        if (!pb) {
            throw new common_1.NotFoundException(`Project branch link ${projectBranchId} not found.`);
        }
        const previousStatus = pb.status;
        const event = project_state_machine_1.ProjectBranchStateMachine.close(pb, userId);
        pb.updatedBy = userId;
        const saved = await repo.save(pb);
        await this.recordBranchTransition(saved, previousStatus, userId);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
};
exports.ProjectService = ProjectService;
exports.ProjectService = ProjectService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(project_entity_1.ProjectEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(project_branch_entity_1.ProjectBranchEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(assessment_entity_1.AssessmentEntity)),
    __param(3, (0, typeorm_1.InjectRepository)(client_entity_1.ClientEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        branch_query_service_1.BranchQueryService,
        branch_service_1.BranchService,
        audit_service_1.AuditService,
        workflow_engine_1.WorkflowEngine,
        domain_event_publisher_1.DomainEventPublisher,
        project_query_service_1.ProjectQueryService])
], ProjectService);
//# sourceMappingURL=project.service.js.map
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
exports.PlanningAntiCorruptionLayer = void 0;
const common_1 = require("@nestjs/common");
const planning_domain_contracts_1 = require("./planning-domain-contracts");
const geo_coordinate_value_object_1 = require("../../core/value-objects/geo-coordinate.value-object");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const branch_entity_1 = require("../branch/branch.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
const assayer_service_1 = require("../assayer/assayer.service");
const assignment_entity_1 = require("../assignment/assignment.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
let PlanningAntiCorruptionLayer = class PlanningAntiCorruptionLayer {
    branchRepository;
    assayerRepository;
    assignmentRepository;
    projectBranchRepository;
    assayerService;
    constructor(branchRepository, assayerRepository, assignmentRepository, projectBranchRepository, assayerService) {
        this.branchRepository = branchRepository;
        this.assayerRepository = assayerRepository;
        this.assignmentRepository = assignmentRepository;
        this.projectBranchRepository = projectBranchRepository;
        this.assayerService = assayerService;
    }
    async getBranchesForPlanning(projectId) {
        const projectBranches = await this.projectBranchRepository.find({
            where: { projectId, isActive: true },
            relations: ['branch'],
        });
        return projectBranches.map((pb) => {
            const b = pb.branch;
            return {
                branchId: new planning_domain_contracts_1.BranchId(b.id),
                branchCode: b.branchCode,
                name: b.name,
                location: new geo_coordinate_value_object_1.GeoCoordinate(b.latitude || 0, b.longitude || 0),
                city: b.city,
                state: b.state,
                requiredSkills: new planning_domain_contracts_1.SkillSet(b.requiredCompetencies || []),
            };
        });
    }
    async getAvailableAssayers(date) {
        const assayers = await this.assayerRepository.find({
            where: { isActive: true, status: 'ACTIVE' },
        });
        await this.assayerService.hydrateAllWorkforceAttributes(assayers);
        return assayers.map((a) => {
            return {
                assayerId: new planning_domain_contracts_1.AssayerId(a.id),
                displayName: a.displayName,
                status: a.status,
                location: new geo_coordinate_value_object_1.GeoCoordinate(a.latitude || 0, a.longitude || 0),
                skills: new planning_domain_contracts_1.SkillSet(a.skills || []),
                maxWeeklyWorkload: a.maxWeeklyWorkload || 15,
            };
        });
    }
    async getAssayerCurrentWorkloads(assayerIds) {
        const assignments = await this.assignmentRepository.find({
            where: { isActive: true },
        });
        const counts = {};
        for (const a of assignments) {
            if (assayerIds.includes(a.assayerId)) {
                counts[a.assayerId] = (counts[a.assayerId] || 0) + 1;
            }
        }
        return counts;
    }
};
exports.PlanningAntiCorruptionLayer = PlanningAntiCorruptionLayer;
exports.PlanningAntiCorruptionLayer = PlanningAntiCorruptionLayer = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(branch_entity_1.BranchEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(assayer_entity_1.AssayerEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __param(3, (0, typeorm_1.InjectRepository)(project_branch_entity_1.ProjectBranchEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        assayer_service_1.AssayerService])
], PlanningAntiCorruptionLayer);
//# sourceMappingURL=planning-acl.adapter.js.map
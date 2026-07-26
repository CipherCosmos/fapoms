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
exports.OperationsProjectMetricsAdapter = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const project_entity_1 = require("../project/project.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const shared_1 = require("@fapoms/shared");
let OperationsProjectMetricsAdapter = class OperationsProjectMetricsAdapter {
    projectRepository;
    projectBranchRepository;
    constructor(projectRepository, projectBranchRepository) {
        this.projectRepository = projectRepository;
        this.projectBranchRepository = projectBranchRepository;
    }
    async getTotalProjectsCount() {
        return this.projectRepository.count({ where: { isActive: true } });
    }
    async getActiveProjectsCount() {
        return this.projectRepository.count({
            where: [
                { status: shared_1.ProjectStatus.EXECUTION, isActive: true },
                { status: shared_1.ProjectStatus.VALIDATION, isActive: true },
            ],
        });
    }
    async getProjectsAtRiskCount(breachedCounts) {
        const activeProjects = await this.projectRepository.find({
            where: [
                { status: shared_1.ProjectStatus.EXECUTION, isActive: true },
                { status: shared_1.ProjectStatus.VALIDATION, isActive: true },
            ],
        });
        let count = 0;
        for (const p of activeProjects) {
            if ((breachedCounts[p.id] || 0) > 2) {
                count++;
            }
        }
        return count;
    }
    async getProjectBranchCounts() {
        const branches = await this.projectBranchRepository.find({ where: { isActive: true } });
        const total = branches.length;
        const deployed = branches.filter((pb) => pb.status !== 'IMPORTED' && pb.status !== 'PLANNING').length;
        return { total, deployed };
    }
};
exports.OperationsProjectMetricsAdapter = OperationsProjectMetricsAdapter;
exports.OperationsProjectMetricsAdapter = OperationsProjectMetricsAdapter = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(project_entity_1.ProjectEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(project_branch_entity_1.ProjectBranchEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository])
], OperationsProjectMetricsAdapter);
//# sourceMappingURL=operations-project-metrics.adapter.js.map
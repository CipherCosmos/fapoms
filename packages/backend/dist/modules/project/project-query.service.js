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
exports.ProjectQueryService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const project_entity_1 = require("./project.entity");
const project_branch_entity_1 = require("./project-branch.entity");
let ProjectQueryService = class ProjectQueryService {
    projectRepository;
    projectBranchRepository;
    constructor(projectRepository, projectBranchRepository) {
        this.projectRepository = projectRepository;
        this.projectBranchRepository = projectBranchRepository;
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
    async findProjectBranches(projectId) {
        return this.projectBranchRepository.find({
            where: { projectId, isActive: true },
            relations: ['branch', 'assignments', 'assignments.assayer'],
        });
    }
    async findProjectBranchById(id) {
        return this.projectBranchRepository.findOne({
            where: { id, isActive: true },
            relations: ['branch', 'project', 'project.client'],
        });
    }
};
exports.ProjectQueryService = ProjectQueryService;
exports.ProjectQueryService = ProjectQueryService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(project_entity_1.ProjectEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(project_branch_entity_1.ProjectBranchEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository])
], ProjectQueryService);
//# sourceMappingURL=project-query.service.js.map
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
exports.SearchService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const branch_entity_1 = require("../branch/branch.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
const project_entity_1 = require("../project/project.entity");
const client_entity_1 = require("../client/client.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
let SearchService = class SearchService {
    branchRepo;
    assayerRepo;
    projectRepo;
    clientRepo;
    assignmentRepo;
    constructor(branchRepo, assayerRepo, projectRepo, clientRepo, assignmentRepo) {
        this.branchRepo = branchRepo;
        this.assayerRepo = assayerRepo;
        this.projectRepo = projectRepo;
        this.clientRepo = clientRepo;
        this.assignmentRepo = assignmentRepo;
    }
    async searchAll(q) {
        const term = `%${q}%`;
        const [branches, assayers, projects, clients, assignments] = await Promise.all([
            this.branchRepo.find({
                where: [
                    { name: (0, typeorm_2.ILike)(term) },
                    { branchCode: (0, typeorm_2.ILike)(term) },
                    { city: (0, typeorm_2.ILike)(term) },
                    { state: (0, typeorm_2.ILike)(term) },
                    { address: (0, typeorm_2.ILike)(term) },
                ],
                take: 10,
                order: { name: 'ASC' },
            }),
            this.assayerRepo.find({
                where: [
                    { displayName: (0, typeorm_2.ILike)(term) },
                    { firstName: (0, typeorm_2.ILike)(term) },
                    { lastName: (0, typeorm_2.ILike)(term) },
                    { assayerCode: (0, typeorm_2.ILike)(term) },
                    { phone: (0, typeorm_2.ILike)(term) },
                    { email: (0, typeorm_2.ILike)(term) },
                ],
                take: 10,
                order: { displayName: 'ASC' },
            }),
            this.projectRepo.find({
                where: [
                    { name: (0, typeorm_2.ILike)(term) },
                    { projectNumber: (0, typeorm_2.ILike)(term) },
                ],
                take: 10,
                order: { name: 'ASC' },
            }),
            this.clientRepo.find({
                where: [
                    { name: (0, typeorm_2.ILike)(term) },
                    { clientCode: (0, typeorm_2.ILike)(term) },
                    { displayName: (0, typeorm_2.ILike)(term) },
                ],
                take: 10,
                order: { name: 'ASC' },
            }),
            this.assignmentRepo.find({
                where: [
                    { assignmentNumber: (0, typeorm_2.ILike)(term) },
                ],
                relations: ['projectBranch', 'projectBranch.branch', 'assayer'],
                take: 10,
                order: { assignmentNumber: 'ASC' },
            }),
        ]);
        return {
            branches: branches.map(b => ({ id: b.id, name: b.name, code: b.branchCode, city: b.city, state: b.state })),
            assayers: assayers.map(a => ({ id: a.id, name: a.displayName, code: a.assayerCode, phone: a.phone })),
            projects: projects.map(p => ({ id: p.id, name: p.name, projectNumber: p.projectNumber })),
            clients: clients.map(c => ({ id: c.id, name: c.name, code: c.clientCode })),
            assignments: assignments.map(a => ({
                id: a.id,
                assignmentNumber: a.assignmentNumber,
                branchName: a.projectBranch?.branch?.name || '',
                assayerName: a.assayer?.displayName || '',
            })),
        };
    }
};
exports.SearchService = SearchService;
exports.SearchService = SearchService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(branch_entity_1.BranchEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(assayer_entity_1.AssayerEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(project_entity_1.ProjectEntity)),
    __param(3, (0, typeorm_1.InjectRepository)(client_entity_1.ClientEntity)),
    __param(4, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository])
], SearchService);
//# sourceMappingURL=search.service.js.map
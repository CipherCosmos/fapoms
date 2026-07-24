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
exports.BranchQueryService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const branch_entity_1 = require("./branch.entity");
let BranchQueryService = class BranchQueryService {
    branchRepository;
    constructor(branchRepository) {
        this.branchRepository = branchRepository;
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
    async findAll(page = 1, limit = 50, clientId, region, zoneId) {
        const query = this.branchRepository.createQueryBuilder('branch')
            .leftJoinAndSelect('branch.contacts', 'contacts')
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
    async findOneByCode(branchCode) {
        return this.branchRepository.findOne({ where: { branchCode, isActive: true } });
    }
};
exports.BranchQueryService = BranchQueryService;
exports.BranchQueryService = BranchQueryService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(branch_entity_1.BranchEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], BranchQueryService);
//# sourceMappingURL=branch-query.service.js.map
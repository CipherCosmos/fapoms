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
exports.PlanningService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const branch_entity_1 = require("../branch/branch.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
let PlanningService = class PlanningService {
    branchRepository;
    assayerRepository;
    constructor(branchRepository, assayerRepository) {
        this.branchRepository = branchRepository;
        this.assayerRepository = assayerRepository;
    }
    async getRecommendedCandidates(branchId) {
        const branch = await this.branchRepository.findOne({
            where: { id: branchId, isActive: true },
        });
        if (!branch) {
            throw new common_1.NotFoundException(`Branch ${branchId} not found.`);
        }
        if (branch.latitude && branch.longitude) {
            const rawResults = await this.assayerRepository.createQueryBuilder('assayer')
                .select([
                'assayer.id AS id',
                'assayer.assayer_code AS "assayerCode"',
                'assayer.display_name AS "displayName"',
                'assayer.phone AS phone',
                'assayer.email AS email',
                'assayer.status AS status',
                'assayer.state AS state',
                'assayer.district AS district',
                'assayer.city AS city',
                `ST_DistanceSphere(assayer.location, ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)) / 1000 AS "distanceKm"`
            ])
                .where('assayer.is_active = :isActive', { isActive: true })
                .andWhere('assayer.status = :status', { status: 'ACTIVE' })
                .setParameter('longitude', branch.longitude)
                .setParameter('latitude', branch.latitude)
                .orderBy('"distanceKm"', 'ASC')
                .getRawMany();
            return rawResults.map(r => ({
                ...r,
                distanceKm: r.distanceKm ? parseFloat(parseFloat(r.distanceKm).toFixed(2)) : null
            }));
        }
        const fallbackResults = await this.assayerRepository.find({
            where: {
                state: branch.state,
                district: branch.district,
                status: 'ACTIVE',
                isActive: true,
            },
            order: { displayName: 'ASC' },
        });
        return fallbackResults.map(a => ({
            id: a.id,
            assayerCode: a.assayerCode,
            displayName: a.displayName,
            phone: a.phone,
            email: a.email,
            status: a.status,
            state: a.state,
            district: a.district,
            city: a.city,
            distanceKm: null,
        }));
    }
};
exports.PlanningService = PlanningService;
exports.PlanningService = PlanningService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(branch_entity_1.BranchEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(assayer_entity_1.AssayerEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository])
], PlanningService);
//# sourceMappingURL=planning.service.js.map
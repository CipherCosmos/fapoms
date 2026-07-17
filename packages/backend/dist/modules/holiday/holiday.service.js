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
exports.HolidayService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const holiday_entity_1 = require("./holiday.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let HolidayService = class HolidayService {
    holidayRepository;
    auditService;
    constructor(holidayRepository, auditService) {
        this.holidayRepository = holidayRepository;
        this.auditService = auditService;
    }
    async create(dto, userId) {
        const holidayDate = new Date(dto.date);
        const holiday = this.holidayRepository.create({
            name: dto.name,
            date: holidayDate,
            type: dto.type,
            applicableStates: dto.applicableStates ?? null,
            year: holidayDate.getFullYear(),
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.holidayRepository.save(holiday);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'HOLIDAY_CREATED',
            entityType: 'HOLIDAY',
            entityId: saved.id,
            userId,
            remarks: `Created holiday ${saved.name} for ${dto.date}`,
        });
        return saved;
    }
    async findOne(id) {
        const holiday = await this.holidayRepository.findOne({ where: { id, isActive: true } });
        if (!holiday) {
            throw new common_1.NotFoundException(`Holiday ${id} not found.`);
        }
        return holiday;
    }
    async findAll(page = 1, limit = 50, year) {
        const query = this.holidayRepository.createQueryBuilder('holiday')
            .where('holiday.is_active = :isActive', { isActive: true });
        if (year) {
            query.andWhere('holiday.year = :year', { year });
        }
        const [holidays, total] = await query
            .orderBy('holiday.date', 'ASC')
            .take(limit)
            .skip((page - 1) * limit)
            .getManyAndCount();
        return { holidays, total };
    }
    async isHoliday(date, stateCode) {
        const formattedDate = date.toISOString().split('T')[0];
        const query = this.holidayRepository.createQueryBuilder('holiday')
            .where('holiday.is_active = :isActive', { isActive: true })
            .andWhere('holiday.date = :date', { date: formattedDate });
        const holidays = await query.getMany();
        if (holidays.length === 0)
            return false;
        if (stateCode) {
            return holidays.some(h => !h.applicableStates || h.applicableStates.length === 0 || h.applicableStates.includes(stateCode));
        }
        return holidays.some(h => !h.applicableStates || h.applicableStates.length === 0);
    }
    async remove(id, userId) {
        const holiday = await this.findOne(id);
        holiday.isActive = false;
        holiday.updatedBy = userId;
        await this.holidayRepository.save(holiday);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'HOLIDAY_DELETED',
            entityType: 'HOLIDAY',
            entityId: id,
            userId,
            remarks: `Soft deleted holiday ${holiday.name}`,
        });
    }
};
exports.HolidayService = HolidayService;
exports.HolidayService = HolidayService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(holiday_entity_1.HolidayEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        audit_service_1.AuditService])
], HolidayService);
//# sourceMappingURL=holiday.service.js.map
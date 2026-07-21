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
exports.NotificationService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const notification_entity_1 = require("./notification.entity");
const audit_service_1 = require("../../core/audit/audit.service");
let NotificationService = class NotificationService {
    notificationRepository;
    auditService;
    constructor(notificationRepository, auditService) {
        this.notificationRepository = notificationRepository;
        this.auditService = auditService;
    }
    async create(dto, systemUser) {
        const notif = this.notificationRepository.create({
            userId: dto.userId,
            title: dto.title,
            message: dto.message,
            link: dto.link ?? null,
            createdBy: systemUser ?? 'SYSTEM',
            updatedBy: systemUser ?? 'SYSTEM',
        });
        const saved = await this.notificationRepository.save(notif);
        return saved;
    }
    async findByUser(userId) {
        return this.notificationRepository.find({
            where: { userId, isActive: true },
            order: { createdAt: 'DESC' },
        });
    }
    async markAsRead(id, userId) {
        const notif = await this.notificationRepository.findOne({
            where: { id, userId, isActive: true },
        });
        if (!notif) {
            throw new common_1.NotFoundException(`Notification ${id} not found.`);
        }
        notif.isRead = true;
        notif.updatedBy = userId;
        const saved = await this.notificationRepository.save(notif);
        return saved;
    }
};
exports.NotificationService = NotificationService;
exports.NotificationService = NotificationService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(notification_entity_1.NotificationEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        audit_service_1.AuditService])
], NotificationService);
//# sourceMappingURL=notification.service.js.map
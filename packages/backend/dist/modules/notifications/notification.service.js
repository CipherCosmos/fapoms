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
exports.NotificationService = exports.ALL_NOTIFICATION_CATEGORIES = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const shared_1 = require("@fapoms/shared");
const notification_entity_1 = require("./notification.entity");
const notification_preference_entity_1 = require("./notification-preference.entity");
const user_entity_1 = require("../user/user.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
const push_notification_service_1 = require("./push-notification.service");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
exports.ALL_NOTIFICATION_CATEGORIES = Object.values(shared_1.NotificationCategory);
let NotificationService = class NotificationService {
    notificationRepository;
    preferenceRepository;
    userRepository;
    assayerRepository;
    pushNotificationService;
    eventPublisher;
    constructor(notificationRepository, preferenceRepository, userRepository, assayerRepository, pushNotificationService, eventPublisher) {
        this.notificationRepository = notificationRepository;
        this.preferenceRepository = preferenceRepository;
        this.userRepository = userRepository;
        this.assayerRepository = assayerRepository;
        this.pushNotificationService = pushNotificationService;
        this.eventPublisher = eventPublisher;
    }
    async notifyAssayer(assayerId, assayerEmail, payload, systemUser) {
        let inAppDelivered = false;
        try {
            await this.notificationRepository.save(this.notificationRepository.create({
                userId: null,
                assayerId,
                title: payload.title,
                message: payload.message,
                link: payload.link ?? null,
                createdBy: systemUser ?? 'SYSTEM',
                updatedBy: systemUser ?? 'SYSTEM',
            }));
            inAppDelivered = true;
        }
        catch (err) {
            console.error(`Failed to create in-app notification for assayer ${assayerId}:`, err?.message);
        }
        try {
            await this.pushNotificationService.sendToUser(assayerId, payload.title, payload.message, payload.data || (payload.link ? { link: payload.link } : undefined));
        }
        catch (err) {
            console.error('Failed to send push notification to assayer:', err?.message);
        }
        return { inAppDelivered };
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
        try {
            await this.pushNotificationService.sendToUser(dto.userId, dto.title, dto.message, dto.data || (dto.link ? { link: dto.link } : undefined));
        }
        catch (err) {
        }
        try {
            this.eventPublisher.publish('notification:new', {
                eventType: 'notification:new',
                id: saved.id,
                userId: dto.userId,
                title: dto.title,
                message: dto.message,
                link: dto.link,
                isRead: false,
                createdAt: saved.createdAt?.toISOString?.() || new Date().toISOString(),
            });
        }
        catch (err) {
        }
        return saved;
    }
    async findByUser(recipientId, opts = {}) {
        const limit = Math.min(opts.limit ?? 25, 100);
        const offset = Math.max(opts.offset ?? 0, 0);
        const qb = this.notificationRepository
            .createQueryBuilder('n')
            .where('(n.userId = :rid OR n.assayerId = :rid)', { rid: recipientId })
            .andWhere('n.isActive = true');
        if (opts.category)
            qb.andWhere('n.category = :category', { category: opts.category });
        if (opts.unreadOnly)
            qb.andWhere('n.isRead = false');
        const [items, total] = await qb
            .orderBy('n.createdAt', 'DESC')
            .skip(offset)
            .take(limit)
            .getManyAndCount();
        const unreadCount = await this.getUnreadCount(recipientId);
        return { items, total, unreadCount };
    }
    async getUnreadCount(recipientId) {
        return this.notificationRepository.count({
            where: [
                { userId: recipientId, isActive: true, isRead: false },
                { assayerId: recipientId, isActive: true, isRead: false },
            ],
        });
    }
    async markAsRead(id, recipientId) {
        const notif = await this.notificationRepository.findOne({
            where: [
                { id, userId: recipientId, isActive: true },
                { id, assayerId: recipientId, isActive: true },
            ],
        });
        if (!notif) {
            throw new common_1.NotFoundException(`Notification ${id} not found.`);
        }
        notif.isRead = true;
        notif.status = shared_1.NotificationStatus.READ;
        notif.readAt = new Date();
        notif.updatedBy = recipientId;
        return this.notificationRepository.save(notif);
    }
    async markAllAsRead(recipientId) {
        const result = await this.notificationRepository
            .createQueryBuilder()
            .update(notification_entity_1.NotificationEntity)
            .set({ isRead: true, status: shared_1.NotificationStatus.READ, readAt: new Date(), updatedBy: recipientId })
            .where('(user_id = :rid OR assayer_id = :rid)', { rid: recipientId })
            .andWhere('is_read = false')
            .execute();
        return result.affected ?? 0;
    }
    async getPreferences(recipientId, isAssayer) {
        const saved = await this.preferenceRepository.find({
            where: isAssayer ? { assayerId: recipientId } : { userId: recipientId },
        });
        const byCategory = new Map(saved.map((p) => [p.category, p]));
        return exports.ALL_NOTIFICATION_CATEGORIES.map((category) => {
            const row = byCategory.get(category);
            return {
                category,
                inApp: row?.inApp ?? true,
                push: row?.push ?? true,
                email: row?.email ?? false,
            };
        });
    }
    async setPreference(recipientId, isAssayer, category, updates) {
        const where = isAssayer ? { assayerId: recipientId, category } : { userId: recipientId, category };
        let row = await this.preferenceRepository.findOne({ where });
        if (!row) {
            row = this.preferenceRepository.create({
                userId: isAssayer ? null : recipientId,
                assayerId: isAssayer ? recipientId : null,
                category,
                inApp: true,
                push: true,
                email: false,
                createdBy: recipientId,
            });
        }
        if (updates.inApp !== undefined)
            row.inApp = updates.inApp;
        if (updates.push !== undefined)
            row.push = updates.push;
        if (updates.email !== undefined)
            row.email = updates.email;
        row.updatedBy = recipientId;
        const saved = await this.preferenceRepository.save(row);
        return { category: saved.category, inApp: saved.inApp, push: saved.push, email: saved.email };
    }
};
exports.NotificationService = NotificationService;
exports.NotificationService = NotificationService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(notification_entity_1.NotificationEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(notification_preference_entity_1.NotificationPreferenceEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(user_entity_1.UserEntity)),
    __param(3, (0, typeorm_1.InjectRepository)(assayer_entity_1.AssayerEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        push_notification_service_1.PushNotificationService,
        domain_event_publisher_1.DomainEventPublisher])
], NotificationService);
//# sourceMappingURL=notification.service.js.map
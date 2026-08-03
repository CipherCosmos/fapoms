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
var NotificationsModule_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationsModule = void 0;
const common_1 = require("@nestjs/common");
const bull_1 = require("@nestjs/bull");
const typeorm_1 = require("@nestjs/typeorm");
const notification_service_1 = require("./notification.service");
const notification_controller_1 = require("./notification.controller");
const notification_entity_1 = require("./notification.entity");
const device_token_entity_1 = require("./device-token.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
const user_entity_1 = require("../user/user.entity");
const fcm_provider_1 = require("../../infrastructure/notifications/fcm-provider");
const push_notification_service_1 = require("./push-notification.service");
const notification_dispatch_service_1 = require("./notification-dispatch.service");
const audit_module_1 = require("../../core/audit/audit.module");
const notification_preference_entity_1 = require("./notification-preference.entity");
const notification_delivery_worker_1 = require("./notification-delivery.worker");
const notification_constants_1 = require("./notification.constants");
const notification_sweeper_1 = require("./notification.sweeper");
let NotificationsModule = class NotificationsModule {
    static { NotificationsModule_1 = this; }
    queue;
    logger = new common_1.Logger(NotificationsModule_1.name);
    static SWEEP_CRON = '*/5 * * * *';
    static ABANDONED_CRON = '7 * * * *';
    constructor(queue) {
        this.queue = queue;
    }
    async onModuleInit() {
        if (process.env.NODE_ENV === 'test')
            return;
        const wanted = {
            sweep: NotificationsModule_1.SWEEP_CRON,
            'fail-abandoned': NotificationsModule_1.ABANDONED_CRON,
        };
        for (const job of await this.queue.getRepeatableJobs()) {
            if (wanted[job.name] && job.cron !== wanted[job.name]) {
                await this.queue.removeRepeatableByKey(job.key);
                this.logger.warn(`Removed stale ${job.name} schedule: ${job.cron}`);
            }
        }
        for (const [name, cron] of Object.entries(wanted)) {
            await this.queue.add(name, {}, { repeat: { cron }, removeOnComplete: true, removeOnFail: false });
        }
        this.logger.log('Notification sweeper schedules registered');
    }
};
exports.NotificationsModule = NotificationsModule;
exports.NotificationsModule = NotificationsModule = NotificationsModule_1 = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([
                notification_entity_1.NotificationEntity, device_token_entity_1.DeviceTokenEntity, user_entity_1.UserEntity, assayer_entity_1.AssayerEntity, notification_preference_entity_1.NotificationPreferenceEntity,
            ]),
            bull_1.BullModule.registerQueue({ name: notification_constants_1.NOTIFICATION_QUEUE }),
            audit_module_1.AuditModule,
        ],
        controllers: [notification_controller_1.NotificationController],
        providers: [
            notification_service_1.NotificationService, push_notification_service_1.PushNotificationService, notification_dispatch_service_1.NotificationDispatchService,
            notification_delivery_worker_1.NotificationDeliveryWorker, notification_sweeper_1.NotificationSweeper, fcm_provider_1.FcmProvider,
        ],
        exports: [notification_service_1.NotificationService, push_notification_service_1.PushNotificationService, notification_dispatch_service_1.NotificationDispatchService],
    }),
    __param(0, (0, bull_1.InjectQueue)(notification_constants_1.NOTIFICATION_QUEUE)),
    __metadata("design:paramtypes", [Object])
], NotificationsModule);
//# sourceMappingURL=notifications.module.js.map
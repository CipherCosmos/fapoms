"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationsModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const notification_service_1 = require("./notification.service");
const notification_controller_1 = require("./notification.controller");
const notification_entity_1 = require("./notification.entity");
const device_token_entity_1 = require("./device-token.entity");
const user_entity_1 = require("../user/user.entity");
const fcm_provider_1 = require("../../infrastructure/notifications/fcm-provider");
const push_notification_service_1 = require("./push-notification.service");
let NotificationsModule = class NotificationsModule {
};
exports.NotificationsModule = NotificationsModule;
exports.NotificationsModule = NotificationsModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([notification_entity_1.NotificationEntity, device_token_entity_1.DeviceTokenEntity, user_entity_1.UserEntity]),
        ],
        controllers: [notification_controller_1.NotificationController],
        providers: [notification_service_1.NotificationService, push_notification_service_1.PushNotificationService, fcm_provider_1.FcmProvider],
        exports: [notification_service_1.NotificationService, push_notification_service_1.PushNotificationService],
    })
], NotificationsModule);
//# sourceMappingURL=notifications.module.js.map
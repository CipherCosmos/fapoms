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
exports.NotificationController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const notification_service_1 = require("./notification.service");
const push_notification_service_1 = require("./push-notification.service");
const guards_1 = require("../auth/guards");
let NotificationController = class NotificationController {
    notificationService;
    pushService;
    constructor(notificationService, pushService) {
        this.notificationService = notificationService;
        this.pushService = pushService;
    }
    async findMyNotifications(req) {
        const list = await this.notificationService.findByUser(req.user.id);
        return {
            success: true,
            data: list,
        };
    }
    async markAsRead(id, req) {
        const notif = await this.notificationService.markAsRead(id, req.user.id);
        return {
            success: true,
            data: notif,
        };
    }
    async registerDeviceToken(req, dto) {
        if (!dto.token || !dto.platform) {
            throw new common_1.BadRequestException('token and platform are required');
        }
        if (!['ios', 'android'].includes(dto.platform)) {
            throw new common_1.BadRequestException('platform must be ios or android');
        }
        await this.pushService.registerToken(req.user.id, dto.token, dto.platform);
        return { success: true };
    }
    async unregisterDeviceToken(req, dto) {
        if (!dto.token)
            throw new common_1.BadRequestException('token is required');
        await this.pushService.unregisterToken(req.user.id, dto.token);
        return { success: true };
    }
};
exports.NotificationController = NotificationController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Get notifications for current user' }),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], NotificationController.prototype, "findMyNotifications", null);
__decorate([
    (0, common_1.Post)(':id/read'),
    (0, swagger_1.ApiOperation)({ summary: 'Mark notification as read' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], NotificationController.prototype, "markAsRead", null);
__decorate([
    (0, common_1.Post)('device-token'),
    (0, swagger_1.ApiOperation)({ summary: 'Register or update push notification device token' }),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], NotificationController.prototype, "registerDeviceToken", null);
__decorate([
    (0, common_1.Post)('device-token/unregister'),
    (0, swagger_1.ApiOperation)({ summary: 'Unregister a push notification device token' }),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], NotificationController.prototype, "unregisterDeviceToken", null);
exports.NotificationController = NotificationController = __decorate([
    (0, swagger_1.ApiTags)('Notifications'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard, guards_1.PermissionsGuard),
    (0, common_1.Controller)('notifications'),
    __metadata("design:paramtypes", [notification_service_1.NotificationService,
        push_notification_service_1.PushNotificationService])
], NotificationController);
//# sourceMappingURL=notification.controller.js.map
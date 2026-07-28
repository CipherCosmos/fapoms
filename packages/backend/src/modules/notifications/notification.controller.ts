import { Controller, Get, Post, Param, Query, UseGuards, ParseUUIDPipe, Req, Body, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationService } from './notification.service';
import { PushNotificationService } from './push-notification.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard } from '../auth/guards';
import { DevicePlatform } from './device-token.entity';

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly pushService: PushNotificationService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get notifications for current user' })
  async findMyNotifications(@Req() req: any) {
    const list = await this.notificationService.findByUser(req.user.id);
    return {
      success: true,
      data: list,
    };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark notification as read' })
  async markAsRead(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const notif = await this.notificationService.markAsRead(id, req.user.id);
    return {
      success: true,
      data: notif,
    };
  }

  @Post('device-token')
  @ApiOperation({ summary: 'Register or update push notification device token' })
  async registerDeviceToken(
    @Req() req: any,
    @Body() dto: { token: string; platform: DevicePlatform },
  ) {
    if (!dto.token || !dto.platform) {
      throw new BadRequestException('token and platform are required');
    }
    if (!['ios', 'android'].includes(dto.platform)) {
      throw new BadRequestException('platform must be ios or android');
    }
    await this.pushService.registerToken(req.user.id, dto.token, dto.platform);
    return { success: true };
  }

  @Post('device-token/unregister')
  @ApiOperation({ summary: 'Unregister a push notification device token' })
  async unregisterDeviceToken(@Req() req: any, @Body() dto: { token: string }) {
    if (!dto.token) throw new BadRequestException('token is required');
    await this.pushService.unregisterToken(req.user.id, dto.token);
    return { success: true };
  }
}

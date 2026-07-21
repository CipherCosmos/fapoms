import { Controller, Get, Post, Param, Query, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationService } from './notification.service';
import { JwtAuthGuard, RolesGuard } from '../auth/guards';

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

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
}

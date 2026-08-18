import { Controller, Get, Post, Put, Param, Query, UseGuards, ParseUUIDPipe, Req, Body, BadRequestException, ParseIntPipe, DefaultValuePipe, ParseBoolPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsIn, MaxLength } from 'class-validator';
import { NotificationCategory } from '@fapoms/shared';
import { NotificationService } from './notification.service';
import { PushNotificationService } from './push-notification.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, AnyAuthenticated } from '../auth/guards';
import { DevicePlatform } from './device-token.entity';
import { rolesOf } from '../assayer/assayer-visibility';


/**
 * Device-token and preference bodies, previously inline object literals with no runtime
 * validation. `token` in particular is the FCM registration string the push worker sends to,
 * so an empty or malformed value silently poisons delivery for that device.
 */
class UpdatePreferenceRequestDto {
  @IsOptional() @IsBoolean()
  inApp?: boolean;

  @IsOptional() @IsBoolean()
  push?: boolean;

  @IsOptional() @IsBoolean()
  email?: boolean;
}

class RegisterDeviceTokenRequestDto {
  @IsString() @IsNotEmpty() @MaxLength(4096)
  token: string;

  @IsIn(['ios', 'android'])
  platform: DevicePlatform;
}

class UnregisterDeviceTokenRequestDto {
  @IsString() @IsNotEmpty() @MaxLength(4096)
  token: string;
}

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly pushService: PushNotificationService,
  ) {}

  /** Assayer tokens carry the single synthetic role `ASSAYER` (see AuthService.validateJwtPayload). */
  private isAssayer(user: any): boolean {
    return rolesOf(user).includes('ASSAYER');
  }

  // These were @Public(). JwtAuthGuard short-circuits public routes with `return true` and
  // never calls super.canActivate(), so the JWT strategy never runs and `req.user` is
  // undefined even when a valid token is sent. This endpoint therefore hit its
  // `if (!userId) return []` guard on every single request and returned an empty list to
  // everyone — the notifications screen could never display anything.
  //
  // Authentication is required here regardless: these return one recipient's own data.
  @Get()
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Get a page of notifications for the authenticated user or assayer' })
  async findMyNotifications(
    @Req() req: any,
    @Query('category') category?: NotificationCategory,
    @Query('unreadOnly', new DefaultValuePipe(false), ParseBoolPipe) unreadOnly?: boolean,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    const page = await this.notificationService.findByUser(req.user.id, { category, unreadOnly, limit, offset });
    return { success: true, data: page.items, meta: { total: page.total, unreadCount: page.unreadCount, limit, offset } };
  }

  @Get('unread-count')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Just the bell badge count — cheap enough to poll on its own' })
  async unreadCount(@Req() req: any) {
    const count = await this.notificationService.getUnreadCount(req.user.id);
    return { success: true, data: { count } };
  }

  @Get('preferences')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Per-category channel preferences for the authenticated recipient' })
  async getPreferences(@Req() req: any) {
    const prefs = await this.notificationService.getPreferences(req.user.id, this.isAssayer(req.user));
    return { success: true, data: prefs };
  }

  @Put('preferences/:category')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Turn a channel on or off for one notification category' })
  async setPreference(
    @Param('category') category: NotificationCategory,
    @Req() req: any,
    @Body() dto: UpdatePreferenceRequestDto,
  ) {
    if (!Object.values(NotificationCategory).includes(category)) {
      throw new BadRequestException(`Unknown category "${category}".`);
    }
    const saved = await this.notificationService.setPreference(req.user.id, this.isAssayer(req.user), category, dto);
    return { success: true, data: saved };
  }

  @Post(':id/read')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Mark one of your own notifications as read' })
  async markAsRead(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    // Previously `req?.user?.id || id`, which fell back to using the *notification id* as the
    // recipient id — letting anyone mark any notification read by knowing its id.
    const notif = await this.notificationService.markAsRead(id, req.user.id);
    return { success: true, data: notif };
  }

  @Post(':id/unread')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Mark one of your own notifications as unread' })
  async markAsUnread(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const notif = await this.notificationService.markAsUnread(id, req.user.id);
    return { success: true, data: notif };
  }

  @Post('read-all')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Mark every one of your unread notifications as read' })
  async markAllAsRead(@Req() req: any) {
    const updated = await this.notificationService.markAllAsRead(req.user.id);
    return { success: true, data: { updated } };
  }

  @Post('device-token')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Register or update push notification device token' })
  async registerDeviceToken(
    @Req() req: any,
    @Body() dto: RegisterDeviceTokenRequestDto,
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
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Unregister a push notification device token' })
  async unregisterDeviceToken(@Req() req: any, @Body() dto: UnregisterDeviceTokenRequestDto) {
    if (!dto.token) throw new BadRequestException('token is required');
    await this.pushService.unregisterToken(req.user.id, dto.token);
    return { success: true };
  }
}

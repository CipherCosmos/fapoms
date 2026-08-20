import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';
import { CallsService } from './calls.service';

class InitiateCallDto {
  @IsUUID()
  queryId: string;
}

class RoomActionDto {
  @IsString()
  roomName: string;
}

/**
 * Voice-call lifecycle for clarification threads. Media is LiveKit's; identity,
 * authorisation and the ring/answer/decline/missed choreography are decided here,
 * where the JWT and the query's ownership can be checked.
 */
@ApiTags('Calls')
@ApiBearerAuth()
@Controller('calls')
@UseGuards(JwtAuthGuard, RolesGuard)
// Class-level on purpose: RolesGuard is deny-by-default, so a handler without explicit
// roles metadata (config/answer/decline/hangup) is refused for everyone. Every call route
// shares one audience — the two sides of a clarification thread and the staff chain above it.
@Roles(SystemRole.ASSAYER, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.OPERATIONS, SystemRole.ADMIN)
export class CallsController {
  constructor(private readonly callsService: CallsService) {}

  @Get('config')
  @ApiOperation({ summary: 'Client-facing LiveKit URL' })
  config() {
    return { success: true, data: this.callsService.config() };
  }

  @Post('initiate')
  @ApiOperation({ summary: 'Ring the other side of a clarification thread' })
  async initiate(@Body() dto: InitiateCallDto, @Req() req: any) {
    const data = await this.callsService.initiate(this.actor(req), dto.queryId);
    return { success: true, data };
  }

  @Post('answer')
  @ApiOperation({ summary: 'Accept an incoming call' })
  async answer(@Body() dto: RoomActionDto, @Req() req: any) {
    const data = await this.callsService.answer(this.actor(req), dto.roomName);
    return { success: true, data };
  }

  @Post('decline')
  @ApiOperation({ summary: 'Decline an incoming call' })
  async decline(@Body() dto: RoomActionDto, @Req() req: any) {
    return { success: true, data: await this.callsService.decline(this.actor(req), dto.roomName) };
  }

  @Post('hangup')
  @ApiOperation({ summary: 'End (or cancel) a call' })
  async hangup(@Body() dto: RoomActionDto, @Req() req: any) {
    return { success: true, data: await this.callsService.hangup(this.actor(req), dto.roomName) };
  }

  private actor(req: any): { id: string; name?: string; isAssayer: boolean } {
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => (typeof r === 'string' ? r : r?.name)).filter(Boolean);
    return {
      id: req.user.id,
      name: req.user?.displayName || req.user?.username || undefined,
      isAssayer: roles.includes(SystemRole.ASSAYER),
    };
  }
}

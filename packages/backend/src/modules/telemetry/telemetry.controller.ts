import { Controller, Post, Get, Body, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SystemRole } from '@fapoms/shared';
import {
  JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, AnyAuthenticated,
} from '../auth/guards';
import { TelemetryService, MAX_TELEMETRY_BATCH } from './telemetry.service';
import type { RawTelemetryEvent } from './telemetry-scrub';

/**
 * Ingests UI interaction telemetry, and reads it back for oversight.
 *
 * The write is open to every signed-in principal — everyone generates their own telemetry — but the
 * server, not the client, decides WHOSE it is: user, session and IP come from the authenticated
 * request, so a client cannot attribute events to someone else. The read is administrators' and
 * auditors' only, the same audience as the audit log.
 */
@ApiTags('Telemetry')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  /** Record a batch of the caller's own UI events. Identity is taken from the request, not the body. */
  @Post()
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Record a batch of UI interaction events' })
  async record(@Body() body: { events?: RawTelemetryEvent[] }, @Req() req: any) {
    const events = body?.events;
    if (!Array.isArray(events)) throw new BadRequestException('events must be an array.');
    if (events.length > MAX_TELEMETRY_BATCH) {
      throw new BadRequestException(`At most ${MAX_TELEMETRY_BATCH} events per request.`);
    }
    const recorded = await this.telemetry.record(events, {
      userId: req.user.id,
      sessionId: req.user.sid ?? null,
      ipAddress: req.ip ?? null,
    });
    return { success: true, data: { recorded } };
  }

  /** One user's recent UI activity — administrators and auditors only. */
  @Get('user')
  @Roles(SystemRole.ADMIN, SystemRole.AUDITOR)
  @RequirePermissions('audit_log:view:platform')
  @ApiOperation({ summary: "A user's UI activity timeline (admin/audit)" })
  async forUser(@Query('userId') userId: string, @Query('limit') limit = 100) {
    if (!userId) throw new BadRequestException('userId is required.');
    const data = await this.telemetry.listForUser(userId, Number(limit) || 100);
    return { success: true, data };
  }
}

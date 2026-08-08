import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { UnifiedAuditService } from './unified-audit.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../../modules/auth/guards';
import { SystemRole } from '@fapoms/shared';

/**
 * Reads back the audit trail `AuditService.recordEvent()` has been writing from
 * dozens of call sites since early in this system's life — project transitions,
 * user edits, password resets, holiday changes, assayer lifecycle moves. Three
 * roles already hold `AUDIT_LOG:VIEW:PLATFORM`, granted specifically for this,
 * but no controller ever existed to read it back: the permission was unusable,
 * and `getEntityHistory()` / `getUserActivity()` on AuditService were fully
 * built and correct with no route calling either.
 */
@ApiTags('Audit Log')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.READ_ONLY_AUDITOR)
@RequirePermissions('audit_log:view:platform')
@Controller('audit-log')
export class AuditLogController {
  constructor(
    private readonly auditService: AuditService,
    private readonly unifiedAuditService: UnifiedAuditService,
  ) {}

  /**
   * Every recorded event for one record, from every trail this system writes to.
   *
   * `/entity` below reads `audit_events` alone, which is three of four trails short — an
   * auditor got a chronological, authoritative-looking answer that silently omitted workflow
   * transitions, assayer activity and every billing movement. This is the endpoint to use
   * when the question is "what happened to this", and `countsBySource` states plainly where
   * the evidence came from.
   */
  @Get('trail')
  @ApiOperation({ summary: 'Unified audit trail for one entity, merged across every history table' })
  async getUnifiedTrail(
    @Query('entityId') entityId: string,
    @Query('entityType') entityType?: string,
    @Query('limit') limit = 200,
  ) {
    if (!entityId) {
      throw new BadRequestException('entityId is required.');
    }
    const { entries, countsBySource } = await this.unifiedAuditService.getTrail(
      entityId,
      entityType,
      Math.min(Number(limit) || 200, 500),
    );
    return { success: true, data: entries, meta: { total: entries.length, countsBySource } };
  }

  @Get('entity')
  @ApiOperation({ summary: 'Audit history for one entity, e.g. entityType=USER&entityId=:id' })
  async getEntityHistory(
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
    @Query('limit') limit = 50,
    @Query('offset') offset = 0,
  ) {
    const { events, total } = await this.auditService.getEntityHistory(entityType, entityId, Number(limit), Number(offset));
    return { success: true, data: events, meta: { total } };
  }

  @Get('user')
  @ApiOperation({ summary: 'Everything a specific user has done, most recent first' })
  async getUserActivity(
    @Query('userId') userId: string,
    @Query('limit') limit = 50,
    @Query('offset') offset = 0,
  ) {
    const { events, total } = await this.auditService.getUserActivity(userId, Number(limit), Number(offset));
    return { success: true, data: events, meta: { total } };
  }

  @Get('recent')
  @ApiOperation({ summary: 'Global activity feed, most recent first' })
  async getRecentActivity(
    @Query('limit') limit = 50,
    @Query('offset') offset = 0,
    @Query('category') category?: string,
  ) {
    const { events, total } = await this.auditService.getRecentActivity(Number(limit), Number(offset), category);
    return { success: true, data: events, meta: { total } };
  }
}

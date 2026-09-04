import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { UnifiedAuditService } from './unified-audit.service';
import { AuditSealService } from './audit-seal.service';
import { ParseLimitPipe } from '../../infrastructure/http/parse-limit.pipe';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../../modules/auth/guards';
import { SystemRole } from '@fapoms/shared';

/**
 * The ceiling the three `audit_events` list routes share, and why it is 500 rather than the
 * pipe's own default of 200.
 *
 * `/entity`, `/user` and `/recent` all read `audit_events` straight through to a TypeORM `take:`
 * (typeorm-audit.repository.ts), and all three used to pass `Number(limit)` there with nothing in
 * the way — `?limit=500000` was one request asking for half a million rows. That table is the
 * fastest-growing one in the system and is deliberately exempt from retention purging (see
 * `1790600000000-DataLifecycleIndexes.ts`), so it only ever gets longer, and every row carries a
 * `metadata` jsonb column, so neither the rows nor the response are small.
 *
 * 500 is not a new number: `/trail` below already clamped by hand at `Math.min(Number(limit) ||
 * 200, 500)`, and an auditor reading a long history is the use these routes exist for, so the
 * ceiling sits above the pipe's general 200. `/trail` keeps its inline clamp rather than moving
 * to the pipe — it is already bounded, and parse-limit.pipe.ts cites it by name as the
 * hand-rolled original the pipe was factored out of.
 *
 * Module-level rather than a `static` on the controller: a static read from a parameter decorator
 * on its own class is evaluated while that class is still being decorated.
 */
const MAX_AUDIT_PAGE_SIZE = 500;

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
@Roles(SystemRole.ADMIN, SystemRole.AUDITOR)
@RequirePermissions('audit_log:view:platform')
@Controller('audit-log')
export class AuditLogController {
  constructor(
    private readonly auditService: AuditService,
    private readonly unifiedAuditService: UnifiedAuditService,
    private readonly auditSealService: AuditSealService,
  ) {}

  /**
   * Prove the trail has not been rewritten.
   *
   * Recomputes the `audit_chain` hash chain from genesis and reports whether it holds — the
   * cryptographic answer to "can you show this evidence was not altered", which append-only storage
   * alone cannot give. `ok:false` names the first chain position that failed and why (content
   * altered, a broken link, or a missing event). `unsealed` is how many recorded events are not yet
   * in the chain (a healthy sealer keeps this near zero); `truncated` means the walk stopped at the
   * page limit before the head.
   */
  @Get('verify')
  @ApiOperation({ summary: 'Verify the audit hash chain (tamper-evidence) and report any break' })
  async verify(@Query('limit', new ParseLimitPipe({ default: 100_000, max: 1_000_000 })) limit: number) {
    const [result, unsealed] = await Promise.all([
      this.auditSealService.verify(limit),
      this.auditSealService.unsealedCount(),
    ]);
    return { success: true, data: { ...result, unsealed } };
  }

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
    @Query('limit', new ParseLimitPipe({ default: 50, max: MAX_AUDIT_PAGE_SIZE })) limit: number,
    @Query('offset') offset = 0,
  ) {
    const { events, total } = await this.auditService.getEntityHistory(entityType, entityId, limit, Number(offset));
    return { success: true, data: events, meta: { total } };
  }

  @Get('user')
  @ApiOperation({ summary: 'Everything a specific user has done, most recent first' })
  async getUserActivity(
    @Query('userId') userId: string,
    @Query('limit', new ParseLimitPipe({ default: 50, max: MAX_AUDIT_PAGE_SIZE })) limit: number,
    @Query('offset') offset = 0,
  ) {
    const { events, total } = await this.auditService.getUserActivity(userId, limit, Number(offset));
    return { success: true, data: events, meta: { total } };
  }

  @Get('recent')
  @ApiOperation({ summary: 'Global activity feed, most recent first' })
  async getRecentActivity(
    @Query('limit', new ParseLimitPipe({ default: 50, max: MAX_AUDIT_PAGE_SIZE })) limit: number,
    @Query('offset') offset = 0,
    @Query('category') category?: string,
  ) {
    const { events, total } = await this.auditService.getRecentActivity(limit, Number(offset), category);
    return { success: true, data: events, meta: { total } };
  }
}

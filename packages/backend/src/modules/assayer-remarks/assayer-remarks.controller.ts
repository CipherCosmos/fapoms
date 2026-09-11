import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { JwtAuthGuard, PermissionsGuard, Roles, RolesGuard } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { AssayerRemarksService, RemarkActor } from './assayer-remarks.service';
import {
  AssayerRemarkCategory,
  REMARK_RATING_MAX,
  REMARK_RATING_MIN,
  REMARK_TEXT_MAX,
  REMARK_WRITE_ROLES,
} from './assayer-remark.contract';

// A real class, not an inline type: the global ValidationPipe runs `whitelist: true` and strips
// any property that carries no class-validator decorator.
class CreateAssayerRemarkRequestDto {
  @IsUUID() assayerId: string;

  @IsInt() @Min(REMARK_RATING_MIN) @Max(REMARK_RATING_MAX)
  rating: number;

  @IsEnum(AssayerRemarkCategory) category: AssayerRemarkCategory;

  @IsString() @IsNotEmpty() @MaxLength(REMARK_TEXT_MAX)
  text: string;

  @IsOptional() @IsUUID() assignmentId?: string;
}

/**
 * `/assayer-remarks` — the only front door for staff remarks.
 *
 * Reads are open to every internal staff role: the point of a remark is that the next person to
 * plan, validate or phone this assayer sees it. Writes are limited to the desks that work with
 * assayers (REMARK_WRITE_ROLES); ASSAYER and CLIENT_USER tokens are refused by RolesGuard on
 * both. Removal is decided in the service — author or moderator — because it depends on who
 * wrote the row, which a decorator cannot see.
 */
@ApiTags('Assayer Remarks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('assayer-remarks')
export class AssayerRemarksController {
  constructor(
    private readonly remarks: AssayerRemarksService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  private actor(req: any): RemarkActor {
    const roleNames: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
    return {
      userId: req.user.id,
      displayName: req.user.displayName ?? req.user.username ?? req.user.email ?? 'Staff',
      roleNames,
      ipAddress: req.ip || req.connection?.remoteAddress,
    };
  }

  /**
   * Both routes carry the assayer's own region ceiling, which `GET /assayers/:id` has always
   * applied and these did not.
   *
   * A remark is a rated judgement about a named person that the planning engine scores from and
   * the next operator reads before phoning them. Reading and writing one about somebody in a
   * region this account is refused sight of is the same boundary as reading their record.
   * Confirmed live: `cert_ops_east` (EAST) posted a rated remark about a WEST assayer, 201.
   *
   * `assertAssayerInScope` is the existing helper — this needed no new join, only the call.
   */
  @Get('assayer/:assayerId')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Remarks about one assayer, newest first, with the summary the engine scores from' })
  async listForAssayer(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Query('limit') limit?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertAssayerInScope(assayerId, scope);
    const parsed = Number(limit);
    const data = await this.remarks.listForAssayer(assayerId, Number.isFinite(parsed) && parsed > 0 ? parsed : 100);
    return { success: true, data };
  }

  @Post()
  @HttpCode(201)
  @Roles(...REMARK_WRITE_ROLES)
  @ApiOperation({ summary: 'Record a rated remark about an assayer' })
  async create(@Body() dto: CreateAssayerRemarkRequestDto, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertAssayerInScope(dto.assayerId, scope);
    // The optional assignment a remark is hung off is region-anchored too, and it is
    // caller-supplied: without this, an in-region remark could cite another region's job.
    await this.regionGuard.assertAssignmentInScope(dto.assignmentId, scope);
    const remark = await this.remarks.create(
      {
        assayerId: dto.assayerId,
        rating: dto.rating,
        category: dto.category,
        text: dto.text,
        assignmentId: dto.assignmentId ?? null,
      },
      this.actor(req),
    );
    return { success: true, data: remark };
  }

  @Delete(':id')
  @HttpCode(204)
  // Anyone who could have written one may try to remove one; the service decides whether this
  // caller is the author or a moderator and refuses otherwise.
  @Roles(...REMARK_WRITE_ROLES)
  @ApiOperation({ summary: 'Retract (author) or remove (moderator) a remark' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ): Promise<void> {
    // The author check the service performs is not the region ceiling: a MODERATOR passes it for
    // every remark in the company, including ones about people in regions this account cannot
    // see. Asserted here, before the service decides who may remove what.
    await this.regionGuard.assertAssayerRemarkInScope(id, scope);
    await this.remarks.remove(id, this.actor(req));
  }
}

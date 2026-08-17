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
  constructor(private readonly remarks: AssayerRemarksService) {}

  private actor(req: any): RemarkActor {
    const roleNames: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
    return {
      userId: req.user.id,
      displayName: req.user.displayName ?? req.user.username ?? req.user.email ?? 'Staff',
      roleNames,
      ipAddress: req.ip || req.connection?.remoteAddress,
    };
  }

  @Get('assayer/:assayerId')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Remarks about one assayer, newest first, with the summary the engine scores from' })
  async listForAssayer(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    const data = await this.remarks.listForAssayer(assayerId, Number.isFinite(parsed) && parsed > 0 ? parsed : 100);
    return { success: true, data };
  }

  @Post()
  @HttpCode(201)
  @Roles(...REMARK_WRITE_ROLES)
  @ApiOperation({ summary: 'Record a rated remark about an assayer' })
  async create(@Body() dto: CreateAssayerRemarkRequestDto, @Req() req: any) {
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
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<void> {
    await this.remarks.remove(id, this.actor(req));
  }
}

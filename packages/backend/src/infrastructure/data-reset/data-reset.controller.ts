/**
 * FAPOMS — Data Reset ("Danger Zone")
 *
 * Lets a super administrator clear accumulated test/seed data during development, with a
 * comprehensive picker of what to keep vs. remove — see wipe-domains.registry.ts for the domain
 * list and data-reset.service.ts for the safety mechanics (live FK-graph conflict checking,
 * force-kept caller, transactional execution, an audit write that cannot silently fail).
 *
 * Same guard stack and audience as PlatformSettingsController: super administrators only.
 */

import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';
import { SystemRole } from '@fapoms/shared';

import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../../modules/auth/guards';
import { DataResetService } from './data-reset.service';
import { BackupOnDemandService } from './backup-on-demand.service';

/**
 * Typed exactly so a fat-fingered or scripted request can't slip past the intent-to-delete step.
 * Not real security — the caller already cleared SUPER_ADMINISTRATOR-only guards to get here —
 * just friction proportional to the action.
 */
export const DATA_RESET_CONFIRMATION_PHRASE = 'DELETE ALL SELECTED DATA';

export class PreviewDataResetDto {
  @IsArray()
  @IsString({ each: true })
  domainKeys: string[];
}

export class ExecuteDataResetDto {
  @IsArray()
  @IsString({ each: true })
  domainKeys: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  keepUserIds?: string[];

  @IsOptional()
  @IsBoolean()
  billingConfirmed?: boolean;

  @IsOptional()
  @IsBoolean()
  takeBackupFirst?: boolean;

  @IsString()
  confirmationPhrase: string;
}

@ApiTags('Data Reset')
@ApiBearerAuth()
@Controller('admin/data-reset')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles(SystemRole.SUPER_ADMINISTRATOR)
export class DataResetController {
  constructor(
    private readonly dataReset: DataResetService,
    private readonly backup: BackupOnDemandService,
  ) {}

  @Get('domains')
  @ApiOperation({ summary: 'Every wipeable domain, with current row counts' })
  async domains() {
    return { success: true, data: await this.dataReset.describeDomains() };
  }

  @Post('preview')
  @ApiOperation({ summary: 'What a selection would actually touch, before committing to it' })
  async preview(@Body() dto: PreviewDataResetDto) {
    return { success: true, data: await this.dataReset.preview(dto.domainKeys) };
  }

  @Post('execute')
  @ApiOperation({ summary: 'Wipe the selected domains' })
  async execute(@Body() dto: ExecuteDataResetDto, @Req() req: any) {
    if (dto.confirmationPhrase !== DATA_RESET_CONFIRMATION_PHRASE) {
      return {
        success: false,
        error: `Confirmation text did not match. Type exactly "${DATA_RESET_CONFIRMATION_PHRASE}".`,
      };
    }

    // The frontend's own "keep me" checkbox is UX only — never trusted as the actual guarantee.
    // Whatever it sent, the caller's own account is force-kept here so "locked myself out" is
    // structurally impossible rather than merely discouraged.
    const keepUserIds = [...new Set([...(dto.keepUserIds ?? []), req.user.id])];

    // A fresh preview, re-run server-side, so a confirm click that raced ahead of what the admin
    // actually looked at (a conflict introduced by another change in between) is caught here
    // rather than silently executed — DataResetService.execute() re-derives this itself and
    // throws a 409 with the same shape preview() would have returned.
    let backup = null as Awaited<ReturnType<BackupOnDemandService['createDump']>> | null;
    if (dto.takeBackupFirst) {
      // On failure this throws and the wipe never starts — see BackupOnDemandService.createDump.
      backup = await this.backup.createDump();
    }

    const result = await this.dataReset.execute({
      domainKeys: dto.domainKeys,
      keepUserIds,
      billingConfirmed: dto.billingConfirmed,
      actorUserId: req.user.id,
      backup,
    });

    return { success: true, data: result };
  }
}

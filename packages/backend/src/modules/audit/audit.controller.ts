import { Controller, Post, Body, Param, ParseUUIDPipe, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty, IsDateString, IsNumber, Min } from 'class-validator';
import { AuditService } from './audit.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

class StartAuditDto {
  @IsUUID() @IsNotEmpty()
  assignmentId: string;
  @IsUUID() @IsNotEmpty()
  assayerId: string;
  @IsUUID() @IsNotEmpty()
  projectId: string;
  @IsUUID() @IsNotEmpty()
  branchId: string;
  @IsDateString() @IsNotEmpty()
  scheduledDate: string;
}

class CloseAuditDto {
  @IsNumber() @Min(0)
  baseFee: number;
  @IsNumber() @Min(0)
  travelAllowance: number;
}

@ApiTags('Audit Operations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('audits')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Post('start')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.ASSAYER)
  @RequirePermissions('audit:create:organization')
  @ApiOperation({ summary: 'Start a field audit' })
  async startAudit(@Body() dto: StartAuditDto) {
    const audit = await this.auditService.startAudit(
      dto.assignmentId,
      dto.assayerId,
      dto.projectId,
      dto.branchId,
      new Date(dto.scheduledDate)
    );
    return {
      success: true,
      data: audit,
    };
  }

  @Post(':id/close')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('audit:update:organization')
  @ApiOperation({ summary: 'Close a field audit and trigger billing and ledger credits' })
  async closeAudit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseAuditDto,
  ) {
    const audit = await this.auditService.closeAudit(id, dto.baseFee, dto.travelAllowance);
    return {
      success: true,
      data: audit,
    };
  }
}

import { Controller, Post, Body, Param, ParseUUIDPipe, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

class StartAuditDto {
  assignmentId: string;
  assayerId: string;
  projectId: string;
  branchId: string;
  scheduledDate: string;
}

class CloseAuditDto {
  baseFee: number;
  travelAllowance: number;
}

@ApiTags('Audit Operations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('audits')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Post('start')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.ASSAYER)
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

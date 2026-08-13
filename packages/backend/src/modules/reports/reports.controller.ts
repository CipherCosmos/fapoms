import { Controller, Get, Param, ParseUUIDPipe, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole, BillingState } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { ReportsService } from './reports.service';
import { EXCEL_MIME } from './excel-export';

const BILLING_ROLES = [
  SystemRole.SUPER_ADMINISTRATOR,
  SystemRole.ADMINISTRATOR,
  SystemRole.FINANCE_MANAGER,
  SystemRole.OPERATIONS_MANAGER,
  SystemRole.OPERATIONS_EXECUTIVE,
];

/** Roster is PII-scoped per caller role inside the service, so keep it to staff. */
const ROSTER_ROLES = STAFF_ROLES;

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  private send(res: Response, buffer: Buffer, filename: string): void {
    const encoded = encodeURIComponent(filename);
    res.set({
      'Content-Type': EXCEL_MIME,
      'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  }

  @Get('coverage/:projectId')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Export project coverage report (branch-level) to Excel' })
  async coverage(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.reportsService.coverage(projectId);
    this.send(res, buffer, `coverage_${projectId}.xlsx`);
  }

  @Get('assignments')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Export assignment status report to Excel' })
  async assignments(
    @Query('status') status?: string,
    @Query('projectBranchStatus') projectBranchStatus?: string,
    @Query('priority') priority?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Res() res?: Response,
  ): Promise<void> {
    const buffer = await this.reportsService.assignments({ status, projectBranchStatus, priority, scope });
    this.send(res!, buffer, `assignments_${Date.now()}.xlsx`);
  }

  @Get('billing')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Export billing entries and invoices to Excel' })
  async billing(
    @Query('clientId') clientId?: string,
    @Query('projectId') projectId?: string,
    @Query('assayerId') assayerId?: string,
    @Query('state') state?: BillingState,
    @Res() res?: Response,
  ): Promise<void> {
    const buffer = await this.reportsService.billing({ clientId, projectId, assayerId, state });
    this.send(res!, buffer, `billing_${Date.now()}.xlsx`);
  }

  @Get('command-center')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Export Command Center territory summary to Excel' })
  async commandCenter(
    @GlobalScopeFilter() scope?: GlobalScope,
    @Res() res?: Response,
  ): Promise<void> {
    const buffer = await this.reportsService.commandCenter(scope ?? {});
    this.send(res!, buffer, `command_center_${Date.now()}.xlsx`);
  }

  @Get('assayer-roster')
  @Roles(...ROSTER_ROLES)
  @ApiOperation({ summary: 'Export assayer roster and payroll rate card to Excel' })
  async assayerRoster(
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Res() res?: Response,
  ): Promise<void> {
    const buffer = await this.reportsService.assayerRoster(req.user, { scope });
    this.send(res!, buffer, `assayer_roster_${Date.now()}.xlsx`);
  }
}
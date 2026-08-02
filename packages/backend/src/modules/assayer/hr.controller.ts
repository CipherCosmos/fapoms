import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { HrWorkforceService } from './hr-workforce.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

/**
 * HR's own workspace.
 *
 * Kept separate from the assayer CRUD controller on purpose: that one is a record
 * editor, this one is the organisation-level read on the workforce. It contains no
 * per-person identity or banking data, so no field-level scoping is needed here.
 */
@ApiTags('HR')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('hr')
export class HrController {
  constructor(private readonly hrWorkforceService: HrWorkforceService) {}

  @Get('workforce')
  // Workforce administration is HR's and admins'. Operations get the coverage view
  // they need from the command centre, which is scoped to planning rather than to
  // people.
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.HR_MANAGER,
  )
  @ApiOperation({ summary: 'Organisation-level workforce analytics for HR' })
  async workforce() {
    return { success: true, data: await this.hrWorkforceService.overview() };
  }
}

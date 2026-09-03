import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { HrWorkforceService } from './hr-workforce.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  /**
   * Named so a role built in Admin → Roles can reach this console.
   *
   * `@Roles` lists built-in role NAMES, a closed set written in code. A role created in the admin
   * screen is a database row that matches none of them, so it was refused here however many
   * permissions somebody attached to it — the whole HR console answered 403 to a role explicitly
   * granted `ASSAYER:VIEW`. `RolesGuard` now falls through to this declaration when the name does
   * not match, which is what makes the role builder mean anything.
   *
   * Read-only: this endpoint returns the workforce overview and writes nothing.
   */
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'Organisation-level workforce analytics for HR' })
  async workforce() {
    return { success: true, data: await this.hrWorkforceService.overview() };
  }
}

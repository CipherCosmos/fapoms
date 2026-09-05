import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { HrWorkforceService } from './hr-workforce.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';

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
  async workforce(@GlobalScopeFilter() scope?: GlobalScope) {
    // This used to answer for the whole organisation regardless of who asked, while the roster
    // right next to it was already region-scoped — so a territorial desk's headcount tile and its
    // own roster page disagreed about how many people existed. `GlobalScopeFilter` derives the
    // caller's regions from their JWT principal when no `?region=` is on the query string, so a
    // region-scoped account narrows here for free; an unrestricted staff account still sees
    // everything, exactly as before.
    return { success: true, data: await this.hrWorkforceService.overview(scope) };
  }
}

import { Controller, Get, Post, Body, Param, Query, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsUUID, IsDateString } from 'class-validator';
import { SchedulingService, CreateScheduleDto } from './scheduling.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, AllowPermissionFallback } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole, ScheduleStatus } from '@fapoms/shared';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { ParsePagePipe } from '../../infrastructure/http/parse-page.pipe';
import { ScheduleEntity } from './schedule.entity';

/**
 * What a CLIENT_USER — a bank employee outside FAPOMS — may see of a schedule.
 *
 * `findAll`/`findOne` load the schedule with its full relation graph (assignment, the
 * assignment's assayer, project) because every internal caller (ops, desk, auditor) legitimately
 * needs all of it. That same raw entity going straight into the HTTP response meant a CLIENT_USER
 * — whose only ceiling was `clientId`, correctly enforced at the row level — received the full
 * graph too: the visiting assayer's home address, exact home coordinates, phone, photograph,
 * performance rating and assignment history (none of it the bank's business), plus FAPOMS's own
 * internal payout numbers for the visit (`proposedFee`, `agreedFee`, `quotedBaseFee`,
 * `quotedTravelFee`, `counterTravelFee` — what the assayer is paid, not what the bank is billed).
 * The client_id scoping this route already does is real and was verified working; this is the
 * missing other half — field-level, not row-level.
 *
 * A schedule and the branch it is for both genuinely belong to this client's own operation, so
 * nothing there is trimmed. Everything about WHO is doing the visit and WHAT FAPOMS pays them
 * does not.
 */
function toClientSafeSchedule(schedule: ScheduleEntity) {
  const branch = schedule.assignment?.projectBranch?.branch;
  return {
    id: schedule.id,
    status: schedule.status,
    scheduledDate: schedule.scheduledDate,
    remarks: schedule.remarks,
    completedAt: schedule.completedAt,
    createdAt: (schedule as any).createdAt,
    updatedAt: (schedule as any).updatedAt,
    project: schedule.project ? { id: schedule.project.id, name: schedule.project.name } : null,
    branch: branch
      ? {
          id: branch.id,
          name: branch.name,
          address: branch.address,
          city: branch.city,
          state: branch.state,
          district: branch.district,
          pincode: branch.pincode,
        }
      : null,
  };
}

function callerIsClientUser(req: any): boolean {
  const roles: string[] = (req?.user?.roles ?? [])
    .map((r: any) => (typeof r === 'string' ? r : r?.name))
    .filter(Boolean);
  return roles.includes(SystemRole.CLIENT_USER);
}

class CreateScheduleRequestDto implements CreateScheduleDto {
  @IsUUID()
  @IsNotEmpty()
  assignmentId: string;

  @IsDateString()
  @IsNotEmpty()
  scheduledDate: string;

  @IsString()
  @IsOptional()
  remarks?: string;
}

class TransitionScheduleRequestDto {
  @IsString()
  @IsNotEmpty()
  targetStatus: ScheduleStatus;

  @IsString()
  @IsOptional()
  remarks?: string;

  @IsDateString()
  @IsOptional()
  scheduledDate?: string;
}

@ApiTags('Scheduling')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('schedules')
export class SchedulingController {
  constructor(
    private readonly schedulingService: SchedulingService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  @Post()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('scheduling:create:organization')
  @ApiOperation({ summary: 'Create a confirmed schedule from an accepted assignment' })
  async create(@Body() dto: CreateScheduleRequestDto, @Req() req: any) {
    const userId = req?.user?.id || '00000000-0000-0000-0000-000000000000';
    const schedule = await this.schedulingService.create(dto, userId);
    return {
      success: true,
      data: schedule,
    };
  }

  @Get()
  // CLIENT_USER named explicitly, not left to the permission fallback: it used to reach this
  // route only by coincidence (its dashboard-only SCHEDULING:VIEW:PLATFORM grant happening to
  // satisfy the permission below), with no client_id ceiling on the query at all. Both are now
  // real — `findAll`'s `branchScopeWhere(scope)` enforces `scope.clientId` as a genuine
  // per-client ceiling (see `global-scope.ts#resolveClientScope`), so this grant is deliberate.
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.AUDITOR, SystemRole.CLIENT_USER)
  @RequirePermissions('scheduling:view:organization')
  /**
   * A role built in Admin → Roles and granted `scheduling:view` gets the calendar.
   *
   * This is the route whose refusal produced the worst screen in the product: `/scheduling`
   * rendered the 403 as "0 active schedules · 0 unscheduled confirmed offers", an empty calendar
   * and "No audits scheduled for this date" — five confident, wrong statements about what work
   * exists (the rendering half of that is fixed in the web app's `queryClient.ts`). The web app
   * offered the page on the strength of this exact permission while the route accepted only names.
   *
   * The permission IS the gate here and always was; the `@Roles` list adds no distinction this key
   * cannot express — note that CLIENT_USER's ceiling is enforced by `findAll`'s
   * `branchScopeWhere(scope)` on the data, not by the name on this line. A custom role is scoped by
   * the same call.
   */
  @AllowPermissionFallback()
  @ApiOperation({ summary: 'List all active schedules' })
  async findAll(
    @Query('page', new ParsePagePipe()) page: number,
    @Query('limit') limit = 50,
    @Query('status') status?: ScheduleStatus,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Req() req?: any,
  ) {
    const result = await this.schedulingService.findAll(
      Number(page),
      Number(limit),
      status,
      dateFrom,
      dateTo,
      scope,
    );
    const isClientUser = callerIsClientUser(req);
    return {
      success: true,
      data: isClientUser ? result.schedules.map(toClientSafeSchedule) : result.schedules,
      meta: {
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: result.total,
        },
      },
    };
  }

  // Declared before @Get(':id') so the literal "assayer-workload" is not swallowed by that route's
  // ParseUUIDPipe (which would 400) — the same ordering discipline assignment.controller uses for
  // its "field-issues" route. Without this the over-booking warning in the schedule modal is dead.
  @Get('assayer-workload')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Get number of confirmed/tentative schedules for an assayer around a date' })
  async getAssayerWorkload(
    @Query('assayerId') assayerId: string,
    @Query('date') date: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    if (!assayerId || !date) {
      return { success: true, data: { count: 0, schedules: [] } };
    }
    // Reveals where an arbitrary assayer is booked; gated on that assayer's own region.
    await this.regionGuard.assertAssayerInScope(assayerId, scope);
    const dt = new Date(date);
    const weekStart = new Date(dt);
    weekStart.setDate(dt.getDate() - dt.getDay());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const data = await this.schedulingService.getAssayerWorkloadInRange(assayerId, weekStart, weekEnd);
    return { success: true, data };
  }

  @Get(':id')
  // Same reasoning as `findAll` above: `SchedulingService.findOne` now asserts the client
  // ceiling (`assertClientAllowed`), so naming CLIENT_USER here is a deliberate grant, not the
  // coincidental permission-fallback access this used to be.
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.AUDITOR, SystemRole.CLIENT_USER)
  @RequirePermissions('scheduling:view:organization')
  @ApiOperation({ summary: 'Get details for a single schedule by ID' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Req() req?: any,
  ) {
    await this.regionGuard.assertScheduleInScope(id, scope);
    const schedule = await this.schedulingService.findOne(id, scope);
    return {
      success: true,
      data: callerIsClientUser(req) ? toClientSafeSchedule(schedule) : schedule,
    };
  }

  @Post(':id/transition')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('scheduling:modify:organization')
  @ApiOperation({ summary: 'Transition schedule state' })
  async transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionScheduleRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // The region ceiling that `findOne` (the read) already enforces must also gate the write.
    // Without it a region-restricted operator who is refused READING a schedule in another region
    // (GET :id calls assertScheduleInScope) could still TRANSITION it — confirmed 2026-09-04, where
    // a SOUTH-scoped OPERATIONS account got 403 on the read but the transition skipped the check
    // (its 400 was an incidental state-machine rejection, not a boundary). Same assertion, same
    // enforcing (non-staged) path scheduling already uses everywhere else.
    await this.regionGuard.assertScheduleInScope(id, scope);
    const userId = req?.user?.id || '00000000-0000-0000-0000-000000000000';
    const schedule = await this.schedulingService.transition(id, dto.targetStatus, userId, dto.remarks, dto.scheduledDate);
    return {
      success: true,
      data: schedule,
    };
  }

  @Get(':id/timeline')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Get unified activity timeline for a schedule' })
  async getTimeline(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertScheduleInScope(id, scope);
    const timeline = await this.schedulingService.getTimeline(id);
    return {
      success: true,
      data: timeline,
    };
  }
}

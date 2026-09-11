import { Controller, Get, Post, Body, Param, Query, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ValidationService, CreateValidationCaseDto } from './validation.service';
import { DeskEscalationService } from './desk-escalation.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole, ValidationStatus } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

import { IsUUID, IsNotEmpty, IsEnum, IsOptional, IsString, IsArray } from 'class-validator';

class CreateValidationCaseRequestDto implements CreateValidationCaseDto {
  @IsUUID()
  @IsNotEmpty()
  projectBranchId: string;

  @IsUUID()
  @IsOptional()
  assessmentId?: string;
}

class AssignReviewerDto {
  @IsUUID()
  reviewerId: string;
}

class TransitionValidationCaseDto {
  @IsEnum(ValidationStatus)
  targetStatus: ValidationStatus;

  @IsOptional()
  @IsString()
  remarks?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  ocrResult?: any;
}

class BulkTransitionValidationCaseDto {
  @IsArray()
  @IsNotEmpty()
  @IsUUID('4', { each: true })
  ids: string[];

  @IsEnum(ValidationStatus)
  targetStatus: ValidationStatus;

  @IsOptional()
  @IsString()
  remarks?: string;
}

/**
 * The desk's region ceiling.
 *
 * This controller had none — not on the list, not on the detail, not on any of the three
 * transitions. A DESK account assigned to one region opened the validation board and worked the
 * whole country's packets. Confirmed live before this change: `cert_desk_east`
 * (`users.regions = ['EAST']`) received 15 cases from `GET /validation` and **all 15** were
 * Maharashtra branches; `POST /validation` registered a WEST project branch for validation, 201;
 * and every case id it had just been shown was assignable and transitionable.
 *
 * Every case reaches a region the same way — `validation_cases.project_branch_id` →
 * `project_branches.branch_id` → `branches.region` — so the list narrows through
 * `applyBranchScope` and the by-id routes assert `assertValidationCaseInScope`, which is that
 * join written once.
 */
@ApiTags('Validation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
// Internal book: staff only. Individual routes narrow this further.
@Roles(...STAFF_ROLES)
@Controller('validation')
export class ValidationController {
  constructor(
    private readonly validationService: ValidationService,
    private readonly deskEscalation: DeskEscalationService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  @Post()
  // The data entry head validates and submits, per how this team actually
  // works — they were previously locked out of the pipeline stage that is their
  // own job.
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @RequirePermissions('validation:create:organization')
  @ApiOperation({ summary: 'Register a project branch for document validation' })
  async create(
    @Body() dto: CreateValidationCaseRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // No case exists yet, so the ceiling is checked on the project branch the case will be about
    // — the same shape `assignment.create` uses for the same reason.
    await this.regionGuard.assertProjectBranchInScope(dto.projectBranchId, scope);
    const vCase = await this.validationService.create(dto, req.user.id);
    return {
      success: true,
      data: vCase,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List validation cases, filterable by branch, status and reviewer' })
  async findAll(
    @Req() req: any,
    @Query('page') page = 1,
    @Query('limit') limit = 50,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Query('projectBranchId') projectBranchId?: string,
    @Query('status') status?: ValidationStatus,
    // 'me' resolves to the caller — a validator's own queue without knowing their uuid.
    @Query('reviewerId') reviewerId?: string,
    @Query('search') search?: string,
    // 'me': cases for branches whose packet was delegated to the caller (validator slice).
    @Query('workedBy') workedBy?: string,
  ) {
    const resolvedReviewer = reviewerId === 'me' ? req.user.id : reviewerId;
    const resolvedWorkedBy = workedBy === 'me' ? req.user.id : workedBy;
    const { validationCases, total } = await this.validationService.findAll(
      Number(page), Number(limit), projectBranchId, status, resolvedReviewer, search, resolvedWorkedBy, scope,
    );
    return {
      success: true,
      data: validationCases,
      meta: {
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
        },
      },
    };
  }

  // Static paths before ':id', or the router parses "team" as a uuid and 400s.
  @Get('team')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @RequirePermissions('validation:view:organization')
  @ApiOperation({ summary: 'People a validation review can be routed to' })
  async team() {
    return { success: true, data: await this.validationService.validationTeam() };
  }

  @Get('workload')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @RequirePermissions('validation:view:organization')
  @ApiOperation({ summary: 'Per-member desk workload: open packets, reviews held, aging' })
  async workload() {
    return { success: true, data: await this.validationService.workload() };
  }

  @Get('activity')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @RequirePermissions('validation:view:organization')
  @ApiOperation({ summary: 'Recent desk activity: assignments, hand-backs, decisions — who did what' })
  async activity(@Query('limit') limit?: number) {
    return { success: true, data: await this.validationService.activity(limit) };
  }

  @Get('attention')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @RequirePermissions('validation:view:organization')
  @ApiOperation({ summary: "The desk's SLA breaches, bucketed: what the head must unstick right now" })
  async attention() {
    return { success: true, data: await this.deskEscalation.attention() };
  }

  @Get(':id/trail')
  @ApiOperation({ summary: 'Merged audit trail for a case and its branch packets' })
  async trail(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertValidationCaseInScope(id, scope);
    return { success: true, data: await this.validationService.trail(id) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details for a validation case by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertValidationCaseInScope(id, scope);
    const vCase = await this.validationService.findOne(id);
    return {
      success: true,
      data: vCase,
    };
  }

  @Post(':id/assign')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  // `validation:edit`, not `validation:assign`: routing a case to a reviewer is a field on the
  // case, and DESK — the head whose job this is — holds EDIT but not ASSIGN, so requiring ASSIGN
  // would shut the desk out of its own routing screen.
  @RequirePermissions('validation:edit:organization')
  @ApiOperation({ summary: 'Assign a validation case to a validator reviewer' })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignReviewerDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertValidationCaseInScope(id, scope);
    const vCase = await this.validationService.assign(id, dto.reviewerId, req.user.id);
    return {
      success: true,
      data: vCase,
    };
  }

  @Post('bulk/transition')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  @RequirePermissions('validation:edit:organization')
  @ApiOperation({ summary: 'Transition a batch of validation cases to a target status' })
  async bulkTransition(
    @Body() dto: BulkTransitionValidationCaseDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // Asked once about the whole batch, before any case moves — a bulk route is its single-id
    // sibling with an extra loop, and refusing halfway through would leave the desk's queue in a
    // state nobody asked for.
    await this.regionGuard.assertValidationCasesInScope(dto.ids, scope);
    const result = await this.validationService.bulkTransition(dto.ids, dto.targetStatus, req.user.id, dto.remarks);
    return { success: true, data: result };
  }

  @Post(':id/transition')
  @Roles(SystemRole.ADMIN, SystemRole.DESK)
  // A transition moves a case through the pipeline, including into approved states, but the two
  // roles here hold EDIT and not APPROVE; the state machine, not this decorator, is what decides
  // which transitions are legal from where.
  @RequirePermissions('validation:edit:organization')
  @ApiOperation({ summary: 'Transition validation case status' })
  async transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionValidationCaseDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // Authorisation before the state machine: a caller with no access to this case is told 403
    // about access, not 400 about which transitions are legal from a status they should never
    // have been told the case is in.
    await this.regionGuard.assertValidationCaseInScope(id, scope);
    const vCase = await this.validationService.transition(id, dto.targetStatus, req.user.id, dto.remarks, dto.notes, dto.ocrResult);
    return {
      success: true,
      data: vCase,
    };
  }
}

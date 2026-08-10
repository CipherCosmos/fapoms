import { Controller, Get, Post, Body, Param, Query, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ValidationService, CreateValidationCaseDto } from './validation.service';
import { DeskEscalationService } from './desk-escalation.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole, ValidationStatus } from '@fapoms/shared';

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
  ) {}

  @Post()
  // The data entry head validates and submits, per how this team actually
  // works — they were previously locked out of the pipeline stage that is their
  // own job.
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER, SystemRole.DATA_ENTRY_HEAD)
  @RequirePermissions('validation:create:organization')
  @ApiOperation({ summary: 'Register a project branch for document validation' })
  async create(@Body() dto: CreateValidationCaseRequestDto, @Req() req: any) {
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
      Number(page), Number(limit), projectBranchId, status, resolvedReviewer, search, resolvedWorkedBy,
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER, SystemRole.DATA_ENTRY_HEAD)
  @ApiOperation({ summary: 'People a validation review can be routed to' })
  async team() {
    return { success: true, data: await this.validationService.validationTeam() };
  }

  @Get('workload')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER, SystemRole.DATA_ENTRY_HEAD)
  @ApiOperation({ summary: 'Per-member desk workload: open packets, reviews held, aging' })
  async workload() {
    return { success: true, data: await this.validationService.workload() };
  }

  @Get('activity')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER, SystemRole.DATA_ENTRY_HEAD)
  @ApiOperation({ summary: 'Recent desk activity: assignments, hand-backs, decisions — who did what' })
  async activity(@Query('limit') limit?: number) {
    return { success: true, data: await this.validationService.activity(limit) };
  }

  @Get('attention')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER, SystemRole.DATA_ENTRY_HEAD)
  @ApiOperation({ summary: "The desk's SLA breaches, bucketed: what the head must unstick right now" })
  async attention() {
    return { success: true, data: await this.deskEscalation.attention() };
  }

  @Get(':id/trail')
  @ApiOperation({ summary: 'Merged audit trail for a case and its branch packets' })
  async trail(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.validationService.trail(id) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details for a validation case by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const vCase = await this.validationService.findOne(id);
    return {
      success: true,
      data: vCase,
    };
  }

  @Post(':id/assign')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER, SystemRole.DATA_ENTRY_HEAD)
  @ApiOperation({ summary: 'Assign a validation case to a validator reviewer' })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignReviewerDto,
    @Req() req: any,
  ) {
    const vCase = await this.validationService.assign(id, dto.reviewerId, req.user.id);
    return {
      success: true,
      data: vCase,
    };
  }

  @Post('bulk/transition')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER, SystemRole.DATA_ENTRY_HEAD)
  @ApiOperation({ summary: 'Transition a batch of validation cases to a target status' })
  async bulkTransition(
    @Body() dto: BulkTransitionValidationCaseDto,
    @Req() req: any,
  ) {
    const result = await this.validationService.bulkTransition(dto.ids, dto.targetStatus, req.user.id, dto.remarks);
    return { success: true, data: result };
  }

  @Post(':id/transition')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER, SystemRole.DATA_ENTRY_HEAD)
  @ApiOperation({ summary: 'Transition validation case status' })
  async transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionValidationCaseDto,
    @Req() req: any,
  ) {
    const vCase = await this.validationService.transition(id, dto.targetStatus, req.user.id, dto.remarks, dto.notes, dto.ocrResult);
    return {
      success: true,
      data: vCase,
    };
  }
}

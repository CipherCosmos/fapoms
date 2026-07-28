import { Controller, Get, Post, Body, Param, Query, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ValidationService, CreateValidationCaseDto } from './validation.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { SystemRole, ValidationStatus } from '@fapoms/shared';

import { IsUUID, IsNotEmpty, IsEnum, IsOptional, IsString } from 'class-validator';

class CreateValidationCaseRequestDto implements CreateValidationCaseDto {
  @IsUUID()
  @IsNotEmpty()
  projectBranchId: string;
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

@ApiTags('Validation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('validation')
export class ValidationController {
  constructor(private readonly validationService: ValidationService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER)
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
  @ApiOperation({ summary: 'List all validation queue cases' })
  async findAll(@Query('page') page = 1, @Query('limit') limit = 50) {
    const { validationCases, total } = await this.validationService.findAll(Number(page), Number(limit));
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER)
  @RequirePermissions('validation:update:organization')
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

  @Post(':id/transition')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER, SystemRole.VALIDATOR)
  @RequirePermissions('validation:update:organization')
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

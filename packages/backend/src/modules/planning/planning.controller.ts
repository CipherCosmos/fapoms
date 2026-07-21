import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsObject } from 'class-validator';

import { PlanningService, CreateBusinessRuleDto, UpdateBusinessRuleDto } from './planning.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

export class CreateBusinessRuleRequestDto implements CreateBusinessRuleDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsString() @IsNotEmpty()
  scope: string; // 'GLOBAL', 'CLIENT', 'BRANCH'

  @IsOptional() @IsString()
  targetId?: string;

  @IsString() @IsNotEmpty()
  ruleType: string; // 'ELIGIBILITY', 'CAPACITY', 'CERTIFICATION', 'TERRITORY'

  @IsObject() @IsNotEmpty()
  conditions: Record<string, any>;

  @IsOptional() @IsObject()
  actions?: Record<string, any>;
}

export class UpdateBusinessRuleRequestDto implements UpdateBusinessRuleDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  scope?: string;

  @IsOptional() @IsString()
  targetId?: string | null;

  @IsOptional() @IsString()
  ruleType?: string;

  @IsOptional() @IsObject()
  conditions?: Record<string, any>;

  @IsOptional() @IsObject()
  actions?: Record<string, any> | null;
}

@ApiTags('Planning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('planning')
export class PlanningController {
  constructor(private readonly planningService: PlanningService) {}

  @Get('recommendations')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Retrieve and rank candidate assayers for a branch' })
  async getRecommendations(@Query('branchId', ParseUUIDPipe) branchId: string) {
    const recommendations = await this.planningService.getRecommendedCandidates(branchId);
    return {
      success: true,
      data: recommendations,
    };
  }

  // Rule Engine Management REST Endpoints
  @Post('rules')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Create a new business planning rule' })
  async createRule(@Body() dto: CreateBusinessRuleRequestDto, @Req() req: any) {
    const rule = await this.planningService.createRule(dto, req.user.id);
    return {
      success: true,
      data: rule,
    };
  }

  @Put('rules/:id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update a business planning rule by ID' })
  async updateRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBusinessRuleRequestDto,
    @Req() req: any,
  ) {
    const rule = await this.planningService.updateRule(id, dto, req.user.id);
    return {
      success: true,
      data: rule,
    };
  }

  @Delete('rules/:id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete/disable a business planning rule' })
  async deleteRule(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.planningService.deleteRule(id, req.user.id);
    return {
      success: true,
      data: { message: 'Business rule deleted successfully' },
    };
  }

  @Get('rules')
  @ApiOperation({ summary: 'List all active business planning rules' })
  async getRules(@Query('scope') scope?: string) {
    const rules = await this.planningService.getRules(scope);
    return {
      success: true,
      data: rules,
    };
  }

  @Get('rules/:id')
  @ApiOperation({ summary: 'Get a business planning rule by ID' })
  async getRule(@Param('id', ParseUUIDPipe) id: string) {
    const rule = await this.planningService.getRule(id);
    return {
      success: true,
      data: rule,
    };
  }
}

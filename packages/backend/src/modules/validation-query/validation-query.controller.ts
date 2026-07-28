import { Controller, Get, Post, Param, Body, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ValidationQueryService } from './validation-query.service';
import { CreateValidationQueryDto, RespondValidationQueryDto } from './dto/validation-query.dto';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

@ApiTags('Validation Queries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('validation-queries')
export class ValidationQueryController {
  constructor(private readonly validationQueryService: ValidationQueryService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('validation-query:create:organization')
  @ApiOperation({ summary: 'Raise a new validation query to an assayer' })
  async createQuery(@Body() dto: CreateValidationQueryDto, @Req() req: any) {
    const query = await this.validationQueryService.createQuery(dto, req.user.id);
    return {
      success: true,
      data: query,
    };
  }

  @Post(':id/respond')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.ASSAYER, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('validation-query:update:organization')
  @ApiOperation({ summary: 'Assayer responds to a raised validation query' })
  async respondToQuery(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondValidationQueryDto,
    @Req() req: any,
  ) {
    const query = await this.validationQueryService.respondToQuery(id, dto.response, req.user.id);
    return {
      success: true,
      data: query,
    };
  }

  @Post(':id/resolve')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('validation-query:update:organization')
  @ApiOperation({ summary: 'Validator marks a responded query as RESOLVED' })
  async resolveQuery(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const query = await this.validationQueryService.resolveQuery(id, req.user.id);
    return {
      success: true,
      data: query,
    };
  }

  @Get('validation-case/:validationCaseId')
  @ApiOperation({ summary: 'Get all queries raised for a specific validation case' })
  async findByValidationCase(@Param('validationCaseId', ParseUUIDPipe) validationCaseId: string) {
    const list = await this.validationQueryService.findByValidationCase(validationCaseId);
    return {
      success: true,
      data: list,
    };
  }

  @Get('assayer/:assayerId')
  @ApiOperation({ summary: 'Get all pending queries assigned to an assayer' })
  async findByAssayer(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const list = await this.validationQueryService.findByAssayer(assayerId);
    return {
      success: true,
      data: list,
    };
  }
}

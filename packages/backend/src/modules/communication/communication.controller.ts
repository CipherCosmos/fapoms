import { Controller, Get, Post, Body, Param, Query, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty, IsString, IsOptional, IsEnum } from 'class-validator';
import { CommunicationService, CreateCommunicationDto } from './communication.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole, CommunicationType } from '@fapoms/shared';

class CreateCommunicationRequestDto implements CreateCommunicationDto {
  @IsUUID() @IsNotEmpty()
  assignmentId: string;
  @IsEnum(CommunicationType) @IsNotEmpty()
  type: CommunicationType;
  @IsString() @IsNotEmpty()
  content: string;
  @IsOptional() @IsString()
  recipientRef?: string;
}

@ApiTags('Communications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('communications')
export class CommunicationController {
  constructor(private readonly communicationService: CommunicationService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @RequirePermissions('communication:create:organization')
  @ApiOperation({ summary: 'Log a communication record' })
  async create(@Body() dto: CreateCommunicationRequestDto, @Req() req: any) {
    const comm = await this.communicationService.create(dto, req.user.id);
    return {
      success: true,
      data: comm,
    };
  }

  @Get('assignment/:assignmentId')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Get communication history for an assignment' })
  async findByAssignment(@Param('assignmentId', ParseUUIDPipe) assignmentId: string) {
    const history = await this.communicationService.findByAssignment(assignmentId);
    return {
      success: true,
      data: history,
    };
  }
}

import { Controller, Get, Post, Body, Param, Query, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CommunicationService, CreateCommunicationDto } from './communication.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole, CommunicationType } from '@fapoms/shared';

class CreateCommunicationRequestDto implements CreateCommunicationDto {
  assignmentId: string;
  type: CommunicationType;
  content: string;
  recipientRef?: string;
}

@ApiTags('Communications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('communications')
export class CommunicationController {
  constructor(private readonly communicationService: CommunicationService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Log a communication record' })
  async create(@Body() dto: CreateCommunicationRequestDto, @Req() req: any) {
    const comm = await this.communicationService.create(dto, req.user.id);
    return {
      success: true,
      data: comm,
    };
  }

  @Get('assignment/:assignmentId')
  @ApiOperation({ summary: 'Get communication history for an assignment' })
  async findByAssignment(@Param('assignmentId', ParseUUIDPipe) assignmentId: string) {
    const history = await this.communicationService.findByAssignment(assignmentId);
    return {
      success: true,
      data: history,
    };
  }
}

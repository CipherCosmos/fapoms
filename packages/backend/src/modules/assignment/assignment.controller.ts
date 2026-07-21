/**
 * FAPOMS — Assignment Controller
 *
 * REST API endpoints for assignment commitments and scheduling validations (Part 5 §9).
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Query,
  Param,
  UseGuards,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { AssignmentService, CreateAssignmentDto, UpdateAssignmentDetailsDto, TransitionAssignmentDto } from './assignment.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

@ApiTags('Assignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('assignments')
export class AssignmentController {
  constructor(private readonly assignmentService: AssignmentService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Create a new assignment in CREATED status' })
  async create(@Body() dto: CreateAssignmentDto, @Req() req: any) {
    const assignment = await this.assignmentService.create(dto, req.user.id);
    return {
      success: true,
      data: assignment,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List all assignments' })
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const result = await this.assignmentService.findAll(page ? Number(page) : 1, limit ? Number(limit) : 50);
    return {
      success: true,
      data: result.assignments,
      meta: {
        pagination: {
          page: page ? Number(page) : 1,
          limit: limit ? Number(limit) : 50,
          total: result.total,
        },
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details for a single assignment by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const assignment = await this.assignmentService.findOne(id);
    return {
      success: true,
      data: assignment,
    };
  }

  @Put(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Update assignment details' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssignmentDetailsDto,
    @Req() req: any,
  ) {
    const assignment = await this.assignmentService.update(id, dto, req.user.id);
    return {
      success: true,
      data: assignment,
    };
  }

  @Post(':id/transition')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Transition assignment to a new state' })
  async transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionAssignmentDto,
    @Req() req: any,
  ) {
    const assignment = await this.assignmentService.transition(id, dto.targetStatus, req.user.id, dto.remarks, dto.reason, dto.fee, dto.scheduledDate);
    return {
      success: true,
      data: assignment,
    };
  }
}

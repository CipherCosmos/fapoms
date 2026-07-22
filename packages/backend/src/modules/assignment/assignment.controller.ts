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

  @Get('dashboard/summary')
  @ApiOperation({ summary: 'Get assignment status and SLA statistics summary' })
  async getDashboardSummary() {
    const summary = await this.assignmentService.getDashboardSummary();
    return {
      success: true,
      data: summary,
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

  @Get(':id/timeline')
  @ApiOperation({ summary: 'Get unified activity timeline for an assignment' })
  async getTimeline(@Param('id', ParseUUIDPipe) id: string) {
    const timeline = await this.assignmentService.getTimeline(id);
    return {
      success: true,
      data: timeline,
    };
  }

  @Post(':id/comments')
  @ApiOperation({ summary: 'Post a comment to an assignment' })
  async addComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { comment: string },
    @Req() req: any,
  ) {
    const userName = req.user.displayName || req.user.email || 'System User';
    const comment = await this.assignmentService.addComment(id, body.comment, req.user.id, userName);
    return {
      success: true,
      data: comment,
    };
  }
}

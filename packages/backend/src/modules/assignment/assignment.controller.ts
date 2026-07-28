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
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { AssignmentService, CreateAssignmentDto, UpdateAssignmentDetailsDto } from './assignment.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, RequirePermissions, Public } from '../auth/guards';

@ApiTags('Assignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('assignments')
export class AssignmentController {
  constructor(private readonly assignmentService: AssignmentService) {}

  @Get('assayer/:assayerId')
  @Public()
  @ApiOperation({ summary: 'Get active assignments for a specific assayer (Mobile App API)' })
  async findByAssayer(@Param('assayerId') assayerId: string) {
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(assayerId);
    if (!isUuid) {
      const result = await this.assignmentService.findAll(1, 100);
      return { success: true, items: result.assignments };
    }
    const items = await this.assignmentService.findByAssayer(assayerId);
    return { success: true, items };
  }

  @Post(':id/check-in')
  @Public()
  @ApiOperation({ summary: 'GPS Check-in with SyncToken Conflict Check for Assayer Mobile App' })
  async checkIn(@Param('id') id: string, @Body() dto: any, @Req() req: any) {
    const body = dto || {};
    const lat = body.lat ?? body.latitude ?? 0;
    const lng = body.lng ?? body.longitude ?? 0;
    const userId = req?.user?.id || id;

    const result = await this.assignmentService.recordCheckIn(id, lat, lng, body.syncToken, userId);
    if (!result.success) {
      return {
        success: false,
        error: result.error,
        message: result.message,
      };
    }

    return {
      success: true,
      message: result.message,
      syncToken: result.assignment.syncToken,
      timestamp: body.timestamp || new Date().toISOString(),
      data: result.assignment,
    };
  }

  @Post()
  @Public()
  @ApiOperation({ summary: 'Create a new assignment in CREATED status' })
  async create(@Body() dto: CreateAssignmentDto, @Req() req: any) {
    const userId = req?.user?.id || '00000000-0000-0000-0000-000000000000';
    const assignment = await this.assignmentService.create(dto, userId);
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
    @Query('status') status?: string,
  ) {
    const result = await this.assignmentService.findAll(page ? Number(page) : 1, limit ? Number(limit) : 50, status);
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
  @Public()
  @ApiOperation({ summary: 'Update assignment details' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssignmentDetailsDto,
    @Req() req: any,
  ) {
    const userId = req?.user?.id || '00000000-0000-0000-0000-000000000000';
    const assignment = await this.assignmentService.update(id, dto, userId);
    return {
      success: true,
      data: assignment,
    };
  }

  @Post(':id/transition')
  @Public()
  @ApiOperation({ summary: 'Transition assignment to a new state' })
  async transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: any,
    @Req() req: any,
  ) {
    const body = dto || {};
    const targetStatus = body.targetStatus || body.status;
    if (!targetStatus) {
      throw new BadRequestException('targetStatus is required for assignment transition');
    }
    const userId = req?.user?.id || id;
    const assignment = await this.assignmentService.transition(
      id,
      targetStatus,
      userId,
      body.remarks,
      body.reason,
      body.fee,
      body.scheduledDate,
    );
    return {
      success: true,
      data: assignment,
    };
  }

  @Get(':id/timeline')
  @Public()
  @ApiOperation({ summary: 'Get unified activity timeline for an assignment' })
  async getTimeline(@Param('id', ParseUUIDPipe) id: string) {
    const timeline = await this.assignmentService.getTimeline(id);
    return {
      success: true,
      data: timeline,
    };
  }

  @Post(':id/comments')
  @RequirePermissions('assignment:create:organization')
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

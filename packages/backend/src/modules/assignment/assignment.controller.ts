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
  BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { SystemRole } from '@fapoms/shared';
import { AssignmentService, CreateAssignmentDto, UpdateAssignmentDetailsDto } from './assignment.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, Public } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';

@ApiTags('Assignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('assignments')
export class AssignmentController {
  constructor(private readonly assignmentService: AssignmentService) {}

  // Was @Public(), and any non-UUID path segment fell through to findAll() — so
  // `GET /assignments/assayer/x` returned the entire assignment book to an
  // unauthenticated caller. Now authenticated, and an assayer may only read their
  // own work.
  @Get('assayer/:assayerId')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Get active assignments for a specific assayer (Mobile App API)' })
  async findByAssayer(@Param('assayerId', ParseUUIDPipe) assayerId: string, @Req() req: any) {
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
    const isStaff = roles.some((r) => (STAFF_ROLES as string[]).includes(r));
    if (!isStaff && req.user?.id !== assayerId) {
      throw new ForbiddenException('You may only view your own assignments');
    }
    const items = await this.assignmentService.findByAssayer(assayerId);
    return { success: true, items };
  }

  // Was @Public(). JwtAuthGuard short-circuits public routes without running the JWT
  // strategy, so `req.user` was always undefined here and `userId` fell back to the
  // *assignment id* — every GPS check-in was attributed to the assignment itself rather than
  // the assayer who performed it, making the check-in audit trail meaningless. It also let
  // anyone check in on any assignment without authenticating.
  @Post(':id/check-in')
  @Roles(SystemRole.ASSAYER, SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'GPS Check-in with SyncToken Conflict Check for Assayer Mobile App' })
  async checkIn(@Param('id') id: string, @Body() dto: any, @Req() req: any) {
    const body = dto || {};
    const lat = body.lat ?? body.latitude ?? 0;
    const lng = body.lng ?? body.longitude ?? 0;
    const userId = req.user.id;

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
  @ApiOperation({ summary: 'Create a new assignment in CREATED status' })
  async create(@Body() dto: CreateAssignmentDto, @Req() req: any) {
    const userId = req?.user?.id || '00000000-0000-0000-0000-000000000000';
    const assignment = await this.assignmentService.create(dto, userId);
    return {
      success: true,
      data: assignment,
    };
  }

  // The whole assignment book — staff only. Assayers reach their own work via
  // GET /assignments/assayer/:id.
  @Roles(...STAFF_ROLES)
  @Get()
  @ApiOperation({ summary: 'List all assignments, optionally filtered by status, projectBranchStatus, assessmentStatus, or priority' })
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('projectBranchStatus') projectBranchStatus?: string,
    @Query('assessmentStatus') assessmentStatus?: string,
    @Query('unscheduledOnly') unscheduledOnly?: string,
    @Query('priority') priority?: string,
  ) {
    const result = await this.assignmentService.findAll(
      page ? Number(page) : 1,
      limit ? Number(limit) : 50,
      status,
      projectBranchStatus,
      assessmentStatus,
      unscheduledOnly === 'true' || unscheduledOnly === '1',
      priority,
    );
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
  @ApiOperation({ summary: 'Transition assignment status' })
  async transition(
    @Param('id') id: string,
    @Body() dto: any,
    @Req() req: any,
  ) {
    const body = dto || {};
    const targetStatus = body.targetStatus || body.status;
    if (!targetStatus) {
      throw new BadRequestException('targetStatus is required for assignment transition');
    }
    const userId = req.user.id;
    let assignment: any;
    if (targetStatus === 'COUNTER_OFFER' || targetStatus === 'NEGOTIATION' || (targetStatus === 'PENDING' && (body.counterFee !== undefined || body.fee !== undefined || body.proposedFee !== undefined))) {
      const feeVal = body.counterFee ?? body.fee ?? body.proposedFee;
      if (!feeVal || isNaN(Number(feeVal))) {
        throw new BadRequestException('Valid counter fee amount is required for negotiation.');
      }
      assignment = await this.assignmentService.proposeCounterFee(id, userId, Number(feeVal), body.reason ?? body.remarks);
    } else if (targetStatus === 'ACCEPTED') {
      assignment = await this.assignmentService.acceptOffer(id, userId, undefined, body.reason ?? body.remarks);
    } else if (targetStatus === 'REJECTED') {
      assignment = await this.assignmentService.rejectOffer(id, userId, body.reason ?? body.remarks);
    } else if (targetStatus === 'CHECKED_IN') {
      const lat = Number(body.lat || body.latitude || 28.6315);
      const lng = Number(body.lng || body.longitude || 77.2167);
      const checkInRes = await this.assignmentService.recordCheckIn(id, lat, lng, body.syncToken, userId);
      assignment = checkInRes.assignment || (await this.assignmentService.findOne(id));
    } else if (targetStatus === 'CANCELLED') {
      assignment = await this.assignmentService.cancelAssignment(id, userId, body.reason ?? body.remarks);
    } else if (targetStatus === 'COMPLETED') {
      assignment = await this.assignmentService.completeAssignment(id, userId, body.reason ?? body.remarks);
    } else {
      throw new BadRequestException(`Invalid transition: ${targetStatus}.`);
    }
    return {
      success: true,
      data: assignment,
    };
  }

  @Post(':id/escalate')
  @ApiOperation({ summary: 'Flag an assignment as urgent (sets priority to CRITICAL) and notify the assigning user' })
  async escalate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    const userId = req.user.id;
    const assignment = await this.assignmentService.escalate(id, userId, body?.reason);
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

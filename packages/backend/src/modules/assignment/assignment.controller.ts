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

import { SystemRole, ASSIGNMENT_ISSUE_CATEGORIES } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { AssignmentService, CreateAssignmentDto, UpdateAssignmentDetailsDto } from './assignment.service';
import { OperationsInboxService, SUGGEST_NEXT_AFTER_ATTEMPTS } from './operations-inbox.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, Public } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsUUID, IsBoolean, IsDateString, IsIn, Min, MaxLength } from 'class-validator';

/**
 * Request bodies for the two assignment-mutating routes.
 *
 * Both previously typed their `@Body()` as `CreateAssignmentDto` / `UpdateAssignmentDetailsDto`,
 * which are plain TypeScript *interfaces* declared in assignment.service.ts. Interfaces are
 * erased at compile time, so ValidationPipe had no metadata to work with and every field went
 * through unchecked. An empty `{}` body therefore travelled all the way to the INSERT and came
 * back as `null value in column "assayer_id" violates not-null constraint` — a 500 where the
 * caller should have been told which fields were missing.
 *
 * These classes implement the same interfaces, so the service signatures are unchanged and the
 * compiler enforces that the two stay in step.
 */
class CreateAssignmentRequestDto implements CreateAssignmentDto {
  @IsUUID()
  projectBranchId: string;

  @IsUUID()
  assayerId: string;

  @IsOptional() @IsNumber() @Min(0)
  proposedFee?: number;

  @IsOptional() @IsDateString()
  scheduledDate?: string;

  @IsOptional() @IsString()
  remarks?: string;

  @IsOptional() @IsBoolean()
  autoSchedule?: boolean;

  /**
   * Confirm the assignment on the assayer's behalf instead of leaving a PENDING offer.
   *
   * Reachable only by the four roles on `POST /assignments` — the same set already permitted to
   * accept on an assayer's behalf via `POST :id/transition`. This adds no authority; it removes
   * a second round trip from an authority ops already has.
   */
  @IsOptional() @IsBoolean()
  acceptOnBehalf?: boolean;

  @IsOptional() @IsString() @MaxLength(1000)
  acceptanceReason?: string;
}

/** Escalation reason is free text and optional; the endpoint applies a default when absent. */
class EscalateAssignmentRequestDto {
  @IsOptional() @IsString() @MaxLength(1000)
  reason?: string;
}

/** A comment must actually say something — the route already rejects whitespace-only. */
class AddCommentRequestDto {
  @IsString() @IsNotEmpty() @MaxLength(4000)
  comment: string;
}

/** An assayer flagging a problem on their assignment: a known category and an optional note. */
class ReportIssueRequestDto {
  @IsIn(ASSIGNMENT_ISSUE_CATEGORIES as unknown as string[])
  category: string;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}

class UpdateAssignmentDetailsRequestDto implements UpdateAssignmentDetailsDto {
  @IsOptional() @IsNumber() @Min(0)
  proposedFee?: number;

  @IsOptional() @IsNumber() @Min(0)
  agreedFee?: number;

  @IsOptional() @IsDateString()
  scheduledDate?: string;

  @IsOptional() @IsString()
  remarks?: string;
}

@ApiTags('Assignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('assignments')
export class AssignmentController {
  constructor(
    private readonly assignmentService: AssignmentService,
    private readonly operationsInbox: OperationsInboxService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  // Was @Public(), and any non-UUID path segment fell through to findAll() — so
  // `GET /assignments/assayer/x` returned the entire assignment book to an
  // unauthenticated caller. Now authenticated, and an assayer may only read their
  // own work.
  @Get('assayer/:assayerId')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Get active assignments for a specific assayer (Mobile App API)' })
  async findByAssayer(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
    const isStaff = roles.some((r) => (STAFF_ROLES as string[]).includes(r));
    if (!isStaff && req.user?.id !== assayerId) {
      throw new ForbiddenException('You may only view your own assignments');
    }
    // Staff pass the role check above but are still bound by their region assignment: this
    // returns an assayer's whole book, so a West operator must not be able to read the South's
    // people by id. Assayers reading their own work carry no assignment and are unaffected.
    await this.regionGuard.assertAssayerInScope(assayerId, scope);
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

    /**
     * A check-in with no position is refused rather than recorded at (0, 0).
     *
     * This previously read `body.lat ?? body.latitude ?? 0`, so a request carrying no
     * coordinates at all produced a *successful* check-in at latitude 0, longitude 0 — a point
     * in the Gulf of Guinea. That is not a degraded record, it is a false one: the system
     * would assert that a field worker was somewhere they have certainly never been, and the
     * row is indistinguishable from a genuine reading.
     *
     * Since check-in is the evidence that an assayer physically attended a bank branch, a
     * missing fix must fail loudly so the app can prompt the worker to enable location.
     */
    const rawLat = body.lat ?? body.latitude;
    const rawLng = body.lng ?? body.longitude;
    const lat = Number(rawLat);
    const lng = Number(rawLng);

    if (rawLat === undefined || rawLat === null || rawLng === undefined || rawLng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new BadRequestException(
        'Check-in needs your location. Turn on location for the app and try again.',
      );
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new BadRequestException('The location reported for this check-in is not a valid coordinate.');
    }
    // Exactly (0,0) is never a real Indian branch and is the classic "unset value" signature.
    if (lat === 0 && lng === 0) {
      throw new BadRequestException(
        'Your device did not report a real location. Step outside if you are indoors, then try again.',
      );
    }

    const accuracy = Number.isFinite(Number(body.accuracy)) ? Number(body.accuracy) : undefined;
    const userId = req.user.id;

    const result = await this.assignmentService.recordCheckIn(id, lat, lng, body.syncToken, userId, accuracy);
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  // Read `data.status` rather than assuming: with `acceptOnBehalf` the response is ACCEPTED, and
  // if the confirmation could not be applied it comes back PENDING as a live offer instead.
  @ApiOperation({ summary: 'Create an assignment — a PENDING offer, or ACCEPTED when the desk confirms on the assayer behalf' })
  async create(@Body() dto: CreateAssignmentRequestDto, @Req() req: any) {
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
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const result = await this.assignmentService.findAll(
      page ? Number(page) : 1,
      limit ? Number(limit) : 50,
      status,
      projectBranchStatus,
      assessmentStatus,
      unscheduledOnly === 'true' || unscheduledOnly === '1',
      priority,
      scope,
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
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Get assignment status and SLA statistics summary' })
  async getDashboardSummary(@GlobalScopeFilter() scope?: GlobalScope) {
    const summary = await this.assignmentService.getDashboardSummary(scope);
    return {
      success: true,
      data: summary,
    };
  }

  /**
   * What the movement trail says about the journey this assignment paid travel for.
   *
   * Staff-only, and read-only: this is evidence for a person approving a claim, never an automatic
   * decision. The response distinguishes "not observed" from "observed and short" — see
   * travel-track.ts — so a reviewer is never handed a shortfall the data did not earn.
   */
  @Get(':id/travel-verification')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Compare the recorded movement trail against the travel this assignment was quoted' })
  async travelVerification(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertAssignmentInScope(id, scope);
    return { success: true, data: await this.assignmentService.getTravelVerification(id) };
  }

  /**
   * The desk's queue of problems the field has flagged. Declared before `@Get(':id')` so the
   * literal "field-issues" is never parsed as an assignment id by that route's ParseUUIDPipe.
   */
  @Get('field-issues')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Field issues assayers have reported, newest first' })
  async fieldIssues(@GlobalScopeFilter() scope?: GlobalScope) {
    const issues = await this.assignmentService.listFieldIssues(scope);
    return { success: true, data: issues };
  }

  /**
   * The Operations Inbox — every assignment needing a human decision, as one queue: call tasks
   * (phone-channel offers + app offers gone quiet), open negotiations, declines needing a
   * replacement, accepted-but-unscheduled, overdue-without-check-in, plus the field issues.
   * Declared before `:id` so "inbox" is never parsed as an assignment id.
   */
  @Get('inbox')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Operations inbox: all assignments awaiting a desk decision' })
  async operationsInboxQueue(@GlobalScopeFilter() scope?: GlobalScope) {
    const [inbox, fieldIssues] = await Promise.all([
      this.operationsInbox.getInbox(scope),
      this.assignmentService.listFieldIssues(scope),
    ]);
    return {
      success: true,
      data: { ...inbox, fieldIssues: fieldIssues.filter((i: any) => i.open), suggestNextAfterAttempts: SUGGEST_NEXT_AFTER_ATTEMPTS },
    };
  }

  @Get(':id')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Get details for a single assignment by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    // No-op for the mobile app: an ASSAYER principal carries no region assignment.
    await this.regionGuard.assertAssignmentInScope(id, scope);
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
    @Body() dto: UpdateAssignmentDetailsRequestDto,
    @Req() req: any,
  ) {
    const userId = req?.user?.id || '00000000-0000-0000-0000-000000000000';
    const assignment = await this.assignmentService.update(id, dto, userId);
    return {
      success: true,
      data: assignment,
    };
  }

  // Driving the assignment lifecycle (accept/reject/cancel/complete/negotiate) is an operations
  // action — and COMPLETED feeds billing — so it is NOT open to the full STAFF_ROLES read set.
  // READ_ONLY_AUDITOR/FINANCE_MANAGER/validation/doc/HR roles are viewers here. ASSAYER is allowed
  // but constrained to their own assignment and a subset of transitions by the guard below.
  @Post(':id/transition')
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR,
    SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER,
    SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.ASSAYER,
  )
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

    /**
     * An assayer may only drive their OWN assignment, and only through the transitions that
     * are theirs to make.
     *
     * There was no ownership check here at all. Any authenticated assayer could POST to any
     * assignment id and: reject someone else's offer (which resets the branch to
     * CANDIDATE_SEARCH and frees it), accept work assigned to a colleague, or — worst —
     * set the agreed fee via a counter-offer, which feeds straight into billing. Cancelling
     * and completing are back-office decisions and were reachable by the field app too.
     */
    const callerRoles: string[] = (req.user?.roles ?? [])
      .map((r: any) => (typeof r === 'string' ? r : r?.name))
      .filter(Boolean);
    const callerIsAssayer = callerRoles.includes(SystemRole.ASSAYER);

    if (callerIsAssayer) {
      const ASSAYER_TRANSITIONS = ['ACCEPTED', 'REJECTED', 'CHECKED_IN', 'COUNTER_OFFER', 'NEGOTIATION', 'PENDING'];
      if (!ASSAYER_TRANSITIONS.includes(targetStatus)) {
        throw new ForbiddenException(
          'Cancelling or completing an assignment is done by the operations team, not from the field app.',
        );
      }
      const owned = await this.assignmentService.findOne(id);
      if (!owned || owned.assayerId !== userId) {
        throw new ForbiddenException('You can only act on an assignment that is assigned to you.');
      }
    }

    let assignment: any;
    if (targetStatus === 'COUNTER_OFFER' || targetStatus === 'NEGOTIATION' || (targetStatus === 'PENDING' && (body.counterFee !== undefined || body.fee !== undefined || body.proposedFee !== undefined))) {
      const feeVal = body.counterFee ?? body.fee ?? body.proposedFee;
      if (!feeVal || isNaN(Number(feeVal))) {
        throw new BadRequestException('Valid counter fee amount is required for negotiation.');
      }
      assignment = await this.assignmentService.proposeCounterFee(id, userId, Number(feeVal), body.reason ?? body.remarks);
    } else if (targetStatus === 'ACCEPTED') {
      // `fee` lets the desk accept on an assayer's behalf at a verbally-agreed number — the
      // phone-channel flow, where the negotiation happened inside the call, not in the app.
      const acceptFee = body.fee ?? body.agreedFee;
      assignment = await this.assignmentService.acceptOffer(
        id,
        userId,
        acceptFee != null && !isNaN(Number(acceptFee)) ? Number(acceptFee) : undefined,
        body.reason ?? body.remarks,
      );
    } else if (targetStatus === 'REJECTED') {
      /**
       * A decline has to say why.
       *
       * Rejecting frees the branch and drops it back to CANDIDATE_SEARCH, so the next person to
       * plan it needs to know whether the fee was too low, the date impossible, or the site too
       * far — otherwise they re-offer the same thing and it is declined again. Without this the
       * reason defaulted to the literal string "Rejected", which tells replanning nothing.
       * `unable-to-cover`, the desk-side equivalent, already required one.
       */
      const rejectReason = (body.reason ?? body.remarks ?? '').trim();
      if (!rejectReason) {
        throw new BadRequestException(
          'A reason is required when declining an assignment — the branch goes back into planning and the next person needs to know why.',
        );
      }
      assignment = await this.assignmentService.rejectOffer(id, userId, rejectReason);
    } else if (targetStatus === 'CHECKED_IN') {
      // Second check-in path. The dedicated POST :id/check-in route validated coordinates, but
      // this one still defaulted to New Delhi (28.6315, 77.2167) — so the same fabricated
      // attendance record was reachable, just by a different URL. Same rule applies here:
      // no real fix, no check-in.
      const rawLat = body.lat ?? body.latitude;
      const rawLng = body.lng ?? body.longitude;
      const lat = Number(rawLat);
      const lng = Number(rawLng);
      if (rawLat == null || rawLng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
        throw new BadRequestException('Check-in needs your location. Turn on location for the app and try again.');
      }
      const accuracy = Number.isFinite(Number(body.accuracy)) ? Number(body.accuracy) : undefined;
      const checkInRes = await this.assignmentService.recordCheckIn(id, lat, lng, body.syncToken, userId, accuracy);
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Flag an assignment as urgent (sets priority to CRITICAL) and notify the assigning user' })
  async escalate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EscalateAssignmentRequestDto,
    @Req() req: any,
  ) {
    const userId = req.user.id;
    const assignment = await this.assignmentService.escalate(id, userId, body?.reason);
    return {
      success: true,
      data: assignment,
    };
  }

  /**
   * The field app's one channel for an assayer to raise a problem to the desk on their own
   * initiative. Escalation above is ops-only (desk → field); this is field → desk.
   */
  @Post(':id/report-issue')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Assayer flags a problem on their assignment to the operations desk' })
  async reportIssue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReportIssueRequestDto,
    @Req() req: any,
  ) {
    const userId = req.user.id;

    // An assayer may only flag an assignment that is theirs; staff may flag any.
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
    const isStaff = roles.some((r) => (STAFF_ROLES as string[]).includes(r));
    if (!isStaff) {
      const owned = await this.assignmentService.findOne(id);
      if (!owned || owned.assayerId !== userId) {
        throw new ForbiddenException('You can only report an issue on an assignment that is assigned to you.');
      }
    }

    const assignment = await this.assignmentService.reportIssue(id, userId, body.category, body.note);
    return { success: true, data: assignment };
  }

  @Get(':id/timeline')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Get unified activity timeline for an assignment' })
  async getTimeline(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertAssignmentInScope(id, scope);
    const timeline = await this.assignmentService.getTimeline(id);
    return {
      success: true,
      data: timeline,
    };
  }

  // This route declared only @RequirePermissions and no @Roles. Every other route on this
  // controller carries one, and the class does not set a default — so once RolesGuard became
  // deny-by-default this returned 403 to every role including administrators, taking the
  // Assignments page's only mutation with it. Confirmed against the running stack before fixing.
  //
  // Assayers are included because a field note from the person who actually attended the branch
  // is the most useful comment on the thread; the ownership check below keeps them to their own.
  @Post(':id/comments')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Post a comment to an assignment' })
  async addComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddCommentRequestDto,
    @Req() req: any,
  ) {
    const roles: string[] = (req.user?.roles ?? [])
      .map((r: any) => (typeof r === 'string' ? r : r?.name))
      .filter(Boolean);
    if (roles.includes(SystemRole.ASSAYER)) {
      const assignment = await this.assignmentService.findOne(id).catch(() => null);
      if (!assignment || assignment.assayerId !== req.user?.id) {
        throw new ForbiddenException('You can only comment on an assignment of your own.');
      }
    }

    if (!body?.comment?.trim()) {
      throw new BadRequestException('A comment cannot be empty.');
    }
    const userName = req.user.displayName || req.user.email || 'System User';
    const comment = await this.assignmentService.addComment(id, body.comment, req.user.id, userName);
    return {
      success: true,
      data: comment,
    };
  }
}

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
import { ParseLimitPipe } from '../../infrastructure/http/parse-limit.pipe';
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

  /** Send the job with no price. See CreateAssignmentDto.noFee. */
  @IsOptional() @IsBoolean()
  noFee?: boolean;

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

/**
 * A real device fix, or nothing.
 *
 * This lived inline in check-in and is shared with check-out, because both are attendance
 * evidence in a bank-audit system and a rule that protects one and not the other protects
 * neither. Its history is the reason it is this strict: check-in once read
 * `body.lat ?? body.latitude ?? 0`, so a request carrying no coordinates at all produced a
 * *successful* attendance record at (0, 0) — a point in the Gulf of Guinea, indistinguishable in
 * the table from a genuine reading. A missing fix has to fail loudly so the app can ask for
 * location, rather than quietly asserting that a field worker was somewhere they have never been.
 *
 * `action` only shapes the wording; the rules do not vary.
 */
function requireRealCoordinate(body: any, action: 'Check-in' | 'Check-out'): { lat: number; lng: number } {
  const rawLat = body?.lat ?? body?.latitude;
  const rawLng = body?.lng ?? body?.longitude;
  const lat = Number(rawLat);
  const lng = Number(rawLng);

  if (
    rawLat === undefined || rawLat === null || rawLng === undefined || rawLng === null
    || !Number.isFinite(lat) || !Number.isFinite(lng)
  ) {
    throw new BadRequestException(
      `${action} needs your location. Turn on location for the app and try again.`,
    );
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new BadRequestException(
      `The location reported for this ${action.toLowerCase()} is not a valid coordinate.`,
    );
  }
  // Exactly (0,0) is never a real Indian branch and is the classic "unset value" signature.
  if (lat === 0 && lng === 0) {
    throw new BadRequestException(
      'Your device did not report a real location. Step outside if you are indoors, then try again.',
    );
  }
  return { lat, lng };
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
    /**
     * `active` is what the field app runs on — everything in flight plus recently settled work.
     * `history` pages the rest, newest first, via `before`. Omitted, the whole list comes back
     * as it always did, so a handset still on the previous bundle is unaffected by this deploy.
     */
    @Query('scope') listScope?: 'active' | 'history' | 'all',
    @Query('limit') limit?: string,
    @Query('before') before?: string,
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
    if (listScope && !['active', 'history', 'all'].includes(listScope)) {
      throw new BadRequestException(`Unknown scope '${listScope}'. Use active, history or all.`);
    }
    const { assignments, hasMore, nextCursor } = await this.assignmentService.findByAssayer(assayerId, {
      scope: listScope,
      limit: limit ? Number(limit) : undefined,
      before,
    });
    // `items` stays an array: that is the shape the shipped app reads, and paging is additive.
    return { success: true, items: assignments, meta: { hasMore, nextCursor, scope: listScope ?? 'all' } };
  }

  // Was @Public(). JwtAuthGuard short-circuits public routes without running the JWT
  // strategy, so `req.user` was always undefined here and `userId` fell back to the
  // *assignment id* — every GPS check-in was attributed to the assignment itself rather than
  // the assayer who performed it, making the check-in audit trail meaningless. It also let
  // anyone check in on any assignment without authenticating.
  @Post(':id/check-in')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS)
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
    const { lat, lng } = requireRealCoordinate(body, 'Check-in');

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

  /**
   * The assayer leaves the branch, closing the on-site window check-in opened.
   *
   * Coordinates are validated exactly as strictly as check-in's, through the same helper: a
   * departure recorded at (0, 0) would be as false as an arrival there, and "how far from the
   * branch were they when they left?" is only answerable if the fix is real.
   *
   * Does not complete the assignment — see `recordCheckOut` for why leaving and finishing are
   * deliberately separate facts.
   */
  @Post(':id/check-out')
  @Roles(SystemRole.ASSAYER, SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: 'GPS check-out — records when and where the assayer left the branch' })
  async checkOut(@Param('id') id: string, @Body() dto: any, @Req() req: any) {
    const body = dto || {};
    const { lat, lng } = requireRealCoordinate(body, 'Check-out');
    const accuracy = Number.isFinite(Number(body.accuracy)) ? Number(body.accuracy) : undefined;

    const result = await this.assignmentService.recordCheckOut(
      id, lat, lng, body.syncToken, req.user.id, accuracy,
    );
    if (!result.success) {
      return { success: false, error: result.error, message: result.message };
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assignment:create:organization')
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
  @ApiOperation({ summary: 'List all assignments, optionally filtered by status, projectBranchStatus, or priority' })
  async findAll(
    @Query('page') page = 1,
    /**
     * Bounded here rather than trusted from the caller.
     *
     * `Number(limit)` went straight into `findAll`'s `take:`, and `findAll` then re-reads the
     * page with six relations hydrated (projectBranch, its branch, assessment, its branch,
     * assayer, project). `?limit=60000` against the 200k-row assignment table is therefore one
     * request asking the database for 60,000 rows and the process to hold every one of them
     * fully joined — roughly 6 KB a row, so hundreds of megabytes — and every staff role on this
     * route could send it.
     *
     * 50/200 are the numbers the rest of this codebase already settled on: 50 is this route's
     * existing default, so no caller changes behaviour, and 200 is the same ceiling
     * `findByAssayer` clamps to with MAX_ASSAYER_PAGE_SIZE, and the same one branch.controller.ts
     * and customer-master.controller.ts pass to this pipe. See parse-limit.pipe.ts.
     */
    @Query('limit', new ParseLimitPipe({ default: 50, max: 200 })) limit: number,
    @Query('status') status?: string,
    @Query('projectBranchStatus') projectBranchStatus?: string,
    @Query('unscheduledOnly') unscheduledOnly?: string,
    @Query('priority') priority?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const safePage = page ? Number(page) : 1;
    const result = await this.assignmentService.findAll(
      safePage,
      limit,
      status,
      projectBranchStatus,
      unscheduledOnly === 'true' || unscheduledOnly === '1',
      priority,
      scope,
    );
    return {
      success: true,
      data: result.assignments,
      meta: {
        pagination: {
          page: safePage,
          // The clamped value, not the raw query param: a caller that asked for 60,000 has to be
          // told it got 200, or its next page calculation is built on a number it never received.
          limit,
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

  /**
   * The "Falling behind" board — assignments past a deadline or their audit date, ranked
   * most-overdue-first. Reads the SLA machinery (slaStatus / slaDueDate) plus overdue audit
   * dates and surfaces them as one chase list. Declared before `:id` so "falling-behind" is
   * never parsed as an assignment id.
   */
  @Get('falling-behind')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Assignments past a deadline or audit date, ranked most-overdue first' })
  async fallingBehind(@GlobalScopeFilter() scope?: GlobalScope) {
    const items = await this.assignmentService.getFallingBehind(scope);
    return { success: true, data: items };
  }

  @Get(':id')
  @Roles(...STAFF_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Get details for a single assignment by ID' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // No-op for the mobile app: an ASSAYER principal carries no region assignment.
    await this.regionGuard.assertAssignmentInScope(id, scope);
    const assignment = await this.assignmentService.findOne(id);

    /**
     * An assayer may read their own assignment and no one else's.
     *
     * The region guard above is the only other gate on this route, and its own comment records
     * that it does nothing for an assayer principal — they carry no region. So this route
     * answered any assignment id for any signed-in assayer, and it eager-loads
     * `projectBranch.branch` and `assayer`: the branch a customer's gold is held at, and the name
     * of the colleague sent to value it. Nothing enumerable was exposed, since the id is a v4
     * UUID, but an unguessable identifier is not an authorisation check.
     *
     * The same test already guards `POST :id/comments` and the transition route; this read was
     * simply missed. Staff roles are unaffected — they are scoped by region, which is the control
     * that applies to them.
     */
    const roles: string[] = (req.user?.roles ?? [])
      .map((r: any) => (typeof r === 'string' ? r : r?.name))
      .filter(Boolean);
    if (roles.includes(SystemRole.ASSAYER) && !roles.some((r) => STAFF_ROLES.includes(r as SystemRole))
      && assignment.assayerId !== req.user?.id) {
      throw new ForbiddenException('You can only open an assignment of your own.');
    }

    return {
      success: true,
      data: assignment,
    };
  }

  @Put(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.ASSAYER)
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
      /**
       * `IN_PROGRESS` is included because the assayer is the only person who knows when the audit
       * actually started — the desk can see they arrived, not that they have begun counting. It
       * carries no money or scheduling consequence (see `startWork`), so admitting it here grants
       * no authority the assayer did not already have by checking in.
       *
       * Cancelling and completing remain the desk's, which is what the message below explains.
       */
      const ASSAYER_TRANSITIONS = ['ACCEPTED', 'REJECTED', 'CHECKED_IN', 'IN_PROGRESS', 'COUNTER_OFFER', 'NEGOTIATION', 'PENDING'];
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
    if (
      targetStatus === 'COUNTER_OFFER' || targetStatus === 'NEGOTIATION'
      || (targetStatus === 'PENDING'
        && (body.counterTravelFee !== undefined || body.counterFee !== undefined
          || body.fee !== undefined || body.proposedFee !== undefined))
    ) {
      /**
       * What is countered is the travel, not the audit fee — the fee comes from the rate card.
       *
       * `counterTravelFee` is what current clients send. An older mobile build sends the whole
       * fee as `counterFee`/`fee`/`proposedFee`, and those are still read: the travel share of
       * such an offer is the total less the audit fee that was quoted, which is exactly what the
       * old money formula derived anyway. Refusing them would strand every phone that has not
       * updated, mid-negotiation.
       */
      const travelVal = body.counterTravelFee;
      const wholeFeeVal = body.counterFee ?? body.fee ?? body.proposedFee;

      let counterTravel: number;
      if (travelVal !== undefined && travelVal !== null && !isNaN(Number(travelVal))) {
        counterTravel = Number(travelVal);
      } else if (wholeFeeVal !== undefined && wholeFeeVal !== null && !isNaN(Number(wholeFeeVal))) {
        /**
         * A legacy whole-fee body: carve the travel out of it.
         *
         * The clamp here used to be `Math.max(0, whole − base)`, which turned the most likely
         * mistake into silence. A caller that sends the TRAVEL figure in this field — which the
         * operations inbox did for as long as it existed, under a lane headed "Travel fee" — gets
         * `whole < base`, and the clamp wrote travel = 0, dropping the offer to the bare audit fee
         * with no error and a success response. A number below the audit fee is not a whole fee;
         * it is a caller confusion, and it has to fail where it happens.
         */
        const current = await this.assignmentService.findOne(id);
        const base = Number(current?.quotedBaseFee ?? 0);
        const whole = Number(wholeFeeVal);
        if (base > 0 && whole < base) {
          throw new BadRequestException(
            `₹${whole} is less than this assignment's audit fee of ₹${base}, so it cannot be the `
            + 'whole fee. Send the travel amount as counterTravelFee instead.',
          );
        }
        counterTravel = Math.max(0, whole - base);
      } else {
        throw new BadRequestException(
          'A travel amount is required to counter an offer. The audit fee itself is set by the '
          + 'rate card and is not negotiated.',
        );
      }

      if (counterTravel < 0) {
        throw new BadRequestException('A travel amount cannot be negative.');
      }
      assignment = await this.assignmentService.proposeCounterFee(id, userId, counterTravel, body.reason ?? body.remarks);
    } else if (targetStatus === 'ACCEPTED') {
      // `fee` lets the desk accept on an assayer's behalf at a verbally-agreed number — the
      // phone-channel flow, where the negotiation happened inside the call, not in the app.
      //
      // SECURITY — when the caller is the assayer, any supplied fee is IGNORED and the offer is
      // accepted at the standing proposedFee (which already holds the negotiated number).
      // Otherwise an assayer could accept their own assignment at any amount, and because
      // ACCEPTED→ACCEPTED is a valid self-loop, re-accept to bump it upward before completion,
      // then be paid that figure. This guard shipped in 85aa82bf and was accidentally reverted
      // by 89fd422e ten minutes later; the spec beside this controller now pins it.
      const deskSuppliedFee = callerIsAssayer ? undefined : (body.fee ?? body.agreedFee);
      assignment = await this.assignmentService.acceptOffer(
        id,
        userId,
        deskSuppliedFee != null && !isNaN(Number(deskSuppliedFee)) ? Number(deskSuppliedFee) : undefined,
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
      /**
       * A refused check-in is a failure, on this route too.
       *
       * `recordCheckIn` reports a refusal — TOO_FAR_FROM_BRANCH, NOT_SCHEDULED_TODAY,
       * NOT_YOUR_ASSIGNMENT, CONFLICT_ASSIGNMENT_MODIFIED — in its return value rather than by
       * throwing. This route discarded it and fell through to `{ success: true }`, so an assayer
       * fifty kilometres from the branch was told they had checked in while nothing was written.
       * Check-in is the evidence that a person stood inside the vault; reporting one that did not
       * happen is the worst failure this endpoint has, and the dedicated `POST :id/check-in`
       * route has always returned the refusal properly. The two now agree.
       */
      if (!checkInRes.success) {
        return { success: false, error: checkInRes.error, message: checkInRes.message };
      }
      assignment = checkInRes.assignment || (await this.assignmentService.findOne(id));
    } else if (targetStatus === 'IN_PROGRESS') {
      /**
       * Work has started, as distinct from having arrived.
       *
       * `IN_PROGRESS` has always been a first-class AssignmentStatus with two legal paths in the
       * state machine, a status tone in the app, a tab in the web UI, and a place in the states
       * that permit an expense claim — and NOTHING in the codebase could set it. Every one of
       * those readers branched on a value the database could never hold, and the expense gate in
       * particular listed a state that was unreachable.
       *
       * Making it reachable rather than deleting it: the distinction it draws is real (an assayer
       * standing in the branch is not yet an assayer counting stock), the state machine already
       * describes it correctly, and the enum value is written into the Postgres type — removing
       * it would be a migration against live data to erase a distinction the business does make.
       *
       * Deliberately carries no side effects. It does not book, schedule or price anything; the
       * money chain still turns on COMPLETED alone.
       */
      assignment = await this.assignmentService.startWork(id, userId, body.reason ?? body.remarks);
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
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

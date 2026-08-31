import { Inject, forwardRef, Injectable, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In, Not, LessThan, Raw, EntityManager } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

import { AssignmentEntity } from './assignment.entity';
import { OperationsInboxService } from './operations-inbox.service';
import { AssignmentCommentEntity } from './assignment-comment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { CustomerMasterVersionEntity } from '../customer-master/customer-master-version.entity';
import { CustomerRecordEntity } from '../customer-master/customer-record.entity';
import { UserEntity } from '../user/user.entity';
import { NotificationService } from '../notifications/notification.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { HolidayService } from '../holiday/holiday.service';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { AuditService } from '../../core/audit/audit.service';
import { AssayerService } from '../assayer/assayer.service';
import { LocationTrailService } from '../assayer/location-trail.service';
import { LocationPingSource } from '../assayer/assayer-location-ping.entity';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { AssignmentStateMachine } from './assignment.state-machine';
import { ProjectBranchStateMachine } from '../project/project.state-machine';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { RuleBypassService } from '../platform/rule-bypass/rule-bypass.service';
import { ProjectEntity } from '../project/project.entity';
import { COMMITTED_ASSIGNMENT_STATUSES } from './assignment-workload';
import { RoutingService, RouteResult } from '../geo/routing.provider';
import { ValidationService } from '../validation/validation.service';
import { DocumentService } from '../document/document.service';
import { FeePolicyService } from '../pricing/fee-policy.service';
import { EventCategory, ScheduleStatus, AssignmentStatus, ProjectBranchStatus, CustomerMasterStatus, Priority, SystemRole, calculateHaversineDistance, assignmentIssueCategoryLabel, isAssignmentTerminal, BypassableRule, businessDateKey, businessTodayDateKey } from '@fapoms/shared';
import { applyBranchScope, branchScopeWhere, needsBranchJoin } from '../../infrastructure/scope/apply-scope';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { CacheService } from '../../infrastructure/cache/cache.service';

// Fee rates are no longer declared here. They resolve per client contract through
// FeePolicyService — see packages/backend/src/modules/pricing/fee-policy.service.ts.

/**
 * One row of the "Falling behind" board — an assignment that has slipped past a deadline or its
 * audit date and needs chasing. Ranked most-overdue-first by the service, never dropping off
 * until it is resolved. All wording is plain: `slaState` and `nextAction` are already what a
 * non-technical coordinator reads, so no surface has to translate a raw enum.
 */
export interface FallingBehindItem {
  id: string;
  assignmentNumber: string;
  status: string;
  projectId: string | null;
  projectBranchId: string | null;
  branchId: string | null;
  branchName: string | null;
  branchCity: string | null;
  projectName: string | null;
  clientName: string | null;
  assayerId: string | null;
  assayerName: string | null;
  scheduledDate: string | null;
  slaDueDate: string | null;
  /** Whole days past the earliest missed deadline. 0 means it slipped today. */
  daysOverdue: number;
  /** Plain-language description of which deadline was missed. */
  slaState: string;
  /** The one obvious next step. */
  nextAction: 'OPEN' | 'REASSIGN' | 'RESCHEDULE';
}


export interface CreateAssignmentDto {
  projectBranchId: string;
  assayerId: string;
  proposedFee?: number;
  scheduledDate?: string;
  remarks?: string;
  autoSchedule?: boolean;
  /**
   * The desk records the assayer's acceptance at the moment the assignment is raised, instead
   * of leaving a PENDING offer for the assayer to accept in the app.
   *
   * This exists for the phone channel ("Call & Assign"), where the agreement — person, branch,
   * date, fee — has already happened out loud before this record exists. Asking the assayer to
   * then re-accept in the app adds nothing to decide and everything to wait for: the branch
   * sits in PLANNING until they open the app, and an offer past `slaDueDate` is auto-declined
   * (autoDeclineExpiredOffers) — so a job the assayer verbally took can silently come back
   * unstaffed.
   *
   * It is NOT a way to skip validation. The assignment is created through the same path and
   * the same constraint checks, then transitioned PENDING -> ACCEPTED through the same state
   * machine a desk acceptance from the Operations Inbox uses. The audit trail therefore records
   * an ACCEPTED transition performed by the operations user, not by the assayer — who committed
   * the assayer, and when, stays answerable.
   */
  acceptOnBehalf?: boolean;
  /** Free-text note stored on the acceptance audit event, e.g. who was spoken to. */
  acceptanceReason?: string;
}

export interface UpdateAssignmentDetailsDto {
  proposedFee?: number;
  agreedFee?: number;
  scheduledDate?: string;
  remarks?: string;
}

export interface TransitionAssignmentDto {
  targetStatus: AssignmentStatus;
  remarks?: string;
  reason?: string;
  fee?: number;
  scheduledDate?: string;
}

/**
 * How many counter-offers a negotiation may run before the offer auto-declines.
 *
 * The number was written three times in one block — the comparison, a comment, and the message
 * the assayer is shown — so the rule and the explanation of the rule could drift apart, and the
 * person told "3 counter-offers max" would be the last to know if it had.
 */
const DEFAULT_MAX_NEGOTIATION_ROUNDS = 3;

/** Shipped default for the check-in geofence; the saved setting wins. */
const DEFAULT_CHECK_IN_GEOFENCE_METERS = 2000;


/** Rows per page of the field app's work list, and the ceiling a caller may ask for. */
const DEFAULT_ASSAYER_PAGE_SIZE = 50;
const MAX_ASSAYER_PAGE_SIZE = 200;

/**
 * How far back `scope=active` still carries settled work. The earnings screen totals recent
 * completions and the schedule shows a short history, so a strictly open-only list would empty
 * both; everything older is reached through `scope=history`.
 */
const RECENT_TERMINAL_DAYS = Number(process.env.ASSAYER_RECENT_TERMINAL_DAYS) || 60;

/**
 * Keyset cursor over `(createdAt, id)` — the exact key the list is ordered by, so a page
 * boundary inside rows created in the same millisecond neither repeats nor skips one.
 * Opaque to the client on purpose: it is a position, not a filter to hand-edit.
 */
function encodeAssayerCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${new Date(row.createdAt).toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeAssayerCursor(cursor: string): [Date | null, string] {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const date = new Date(iso);
    return [Number.isNaN(date.getTime()) ? null : date, id ?? ''];
  } catch {
    // A malformed cursor returns the first page rather than an error: the client's remedy is
    // the same either way, and a paging bug must not lock an assayer out of their own list.
    return [null, ''];
  }
}

@Injectable()
export class AssignmentService {
  private static readonly logger = new Logger(AssignmentService.name);

  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepository: Repository<AssessmentEntity>,
    private readonly projectQueryService: ProjectQueryService,
    private readonly projectService: ProjectService,
    private readonly assayerService: AssayerService,
    private readonly locationTrail: LocationTrailService,
    private readonly notificationService: NotificationService,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly pushNotificationService: PushNotificationService,
    private readonly holidayService: HolidayService,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly constraintEvaluator: ConstraintEvaluator,
    private readonly ruleBypass: RuleBypassService,
    private readonly settings: PlatformSettingsService,
    private readonly operationsInbox: OperationsInboxService,
    private readonly routingService: RoutingService,
    private readonly validationService: ValidationService,
    private readonly feePolicyService: FeePolicyService,
    @Inject(forwardRef(() => DocumentService))
    private readonly documentService: DocumentService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly uow: UnitOfWork,
    private readonly cache: CacheService,
  ) {}



  /**
   * Bring an assignment's schedule row to COMPLETED, creating it if the assignment was never
   * scheduled through the Scheduling page.
   *
   * `schedules` is 1:1 with `assignments` and carries its own status, so the two can disagree.
   * They are kept aligned here, in the caller's transaction, through the entity manager —
   * previously this was hand-written SQL run outside any transaction, with failures logged to
   * the console and otherwise ignored. The `@OneToOne` on ScheduleEntity.assignment provides
   * the unique constraint that makes "one schedule per assignment" true at the database level,
   * so the find-or-create below cannot produce a duplicate.
   */
  private async syncScheduleCompletion(
    assignment: AssignmentEntity,
    userId: string,
    manager: EntityManager,
  ): Promise<void> {
    const scheduleRepo = manager.getRepository(ScheduleEntity);
    const existing = await scheduleRepo.findOne({ where: { assignmentId: assignment.id } });

    if (existing) {
      existing.status = ScheduleStatus.COMPLETED;
      // Preserved if already set: the first completion is the real one.
      existing.completedAt = existing.completedAt ?? new Date();
      existing.updatedBy = userId;
      await scheduleRepo.save(existing);
      return;
    }

    await scheduleRepo.save(
      scheduleRepo.create({
        assignmentId: assignment.id,
        projectId: assignment.projectId,
        assayerId: assignment.assayerId,
        scheduledDate: assignment.scheduledDate ?? new Date(),
        status: ScheduleStatus.COMPLETED,
        completedAt: new Date(),
        remarks: 'Completed audit',
        createdBy: userId,
        updatedBy: userId,
      }),
    );
  }

  /**
   * Retire the calendar entry for an assignment that is no longer happening.
   *
   * Only completion used to touch the schedule, so cancelling or rejecting a job left its visit
   * on the calendar as CONFIRMED. That was wrong twice over: whoever reads the calendar still
   * sees the branch booked, and — because `unscheduledOnly` asks `NOT EXISTS (… is_active =
   * true)` — the branch drops out of the "ready to book" list, so the work becomes invisible in
   * the one place someone would go to re-book it.
   *
   * Soft-deleted rather than moved to a CANCELLED status: `ScheduleStatus` has no such member,
   * and adding one would need a database enum migration to record a state nobody browses. A
   * cancelled visit is not a visit in a different state — it is a visit that is not happening.
   * The audit trail of why lives on the assignment's own transition event.
   */
  private async retireSchedule(
    assignment: AssignmentEntity,
    userId: string,
    manager: EntityManager,
  ): Promise<void> {
    const scheduleRepo = manager.getRepository(ScheduleEntity);
    const existing = await scheduleRepo.findOne({
      where: { assignmentId: assignment.id, isActive: true },
    });
    if (!existing) return;

    existing.isActive = false;
    existing.updatedBy = userId;
    await scheduleRepo.save(existing);
  }

  /**
   * The next assignment number, from the database sequence.
   *
   * Numbers used to be `ASN-<year>-<four random digits>` against a UNIQUE constraint with no
   * collision handling — nine thousand values a year, so past a few hundred assignments creates
   * started failing with a rolled-back transaction, and past nine thousand they could not
   * succeed at all. `nextval` is atomic and never repeats. Six zero-padded digits so the new
   * family can never textually collide with a legacy four-digit number; the year is kept
   * because operators read it, but the sequence is global (see the migration for why).
   */
  private async nextAssignmentNumber(manager: EntityManager): Promise<string> {
    const rows: Array<{ n: string | number }> = await manager.query(
      `SELECT nextval('assignment_number_seq') AS n`,
    );
    const n = Number(rows?.[0]?.n);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error('assignment_number_seq did not return a value — has migration 1790400000000 run?');
    }
    return `ASN-${new Date().getFullYear()}-${String(n).padStart(6, '0')}`;
  }

  async create(dto: CreateAssignmentDto, userId: string): Promise<AssignmentEntity> {
    const projectBranch = await this.projectQueryService.findProjectBranchById(dto.projectBranchId);

    if (!projectBranch) {
      throw new NotFoundException(`Project branch link ${dto.projectBranchId} not found.`);
    }

    // Guard: block new assignments for branches already completed or under validation
    const terminalBranchStatuses = ['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'];
    if (terminalBranchStatuses.includes(projectBranch.status)) {
      throw new ConflictException(
        `Cannot assign: Branch "${projectBranch.branch?.name || dto.projectBranchId}" is already in ${projectBranch.status.replace(/_/g, ' ')} state. No further assignments are permitted.`
      );
    }

    const assessment = await this.assessmentRepository.findOne({
      where: { projectId: projectBranch.projectId, branchId: projectBranch.branchId, isActive: true },
    });

    // Validate Assayer exists and has the required skills/certifications
    const assayer = await this.assayerService.findOne(dto.assayerId);

    if (!assayer) {
      throw new NotFoundException(`Assayer ${dto.assayerId} not found.`);
    }

    // Validate skills and certifications via ConstraintEvaluator
    if (projectBranch.project) {
      const skillsCheck = this.constraintEvaluator.checkSkillsAndCertifications(assayer, projectBranch.project, dto.scheduledDate ? new Date(dto.scheduledDate) : undefined);
      if (!skillsCheck.passed) {
        throw new BadRequestException(skillsCheck.reason);
      }
    }

    // Check for any active or existing assignment for this branch
    const existingAssignment = await this.assignmentRepository.findOne({
      where: { projectBranchId: projectBranch.id },
      order: { createdAt: 'DESC' },
    });

    if (
      existingAssignment &&
      [
        AssignmentStatus.ACCEPTED,
        AssignmentStatus.CHECKED_IN,
        AssignmentStatus.IN_PROGRESS,
        AssignmentStatus.COMPLETED,
      ].includes(existingAssignment.status)
    ) {
      throw new ConflictException(
        `Branch Busy: An active/completed assignment (${existingAssignment.assignmentNumber}) already exists for this branch in state ${existingAssignment.status}.`
      );
    }

    /**
     * What day this assignment is for: what the caller asked for, else the branch's own audit
     * date, else today.
     *
     * "Today" is the Indian working day, not the server's. The server runs UTC, so between
     * midnight and 05:30 IST its date is still yesterday — an assignment created first thing in
     * the morning was scheduled for the day before, which is a date already past.
     */
    const branchDate = projectBranch.scheduledDate
      ? (typeof projectBranch.scheduledDate === 'string'
          ? (projectBranch.scheduledDate as string).slice(0, 10)
          : businessDateKey(projectBranch.scheduledDate as Date))
      : null;
    const targetDateStr = dto.scheduledDate || branchDate || businessTodayDateKey();
    const scheduledDateObj = new Date(targetDateStr);

    // Dynamic Proposed Fee Calculation based on Assayer Base Fee + Calculated Travel Distance Allowance
    let resolvedProposedFee = dto.proposedFee;
    let calculatedTravelFee = 0;
    let distanceKm = 0;
    /**
     * The whole routing answer, not just its distance. `source` says whether the kilometres
     * below were measured along the road (OSRM) or are a straight-line estimate because the
     * router was unavailable — the two differ by 11–56 % on real pairs, and a travel allowance
     * priced from the estimate must stay distinguishable in audit and in travel verification,
     * so it is frozen onto the offer beside `quotedDistanceKm`. `durationMinutes` lets the
     * transport rate card time the road modes by the real drive rather than an average speed.
     */
    let route: RouteResult | null = null;

    // Home, not the live fix: this distance sets the travel allowance actually billed, and a
    // fee that changes with where somebody's phone was that morning is not auditable.
    if (projectBranch.branch?.latitude && projectBranch.branch?.longitude && assayer.homeLatitude && assayer.homeLongitude) {
      try {
        route = await this.routingService.calculateRoute(
          { latitude: Number(projectBranch.branch.latitude), longitude: Number(projectBranch.branch.longitude) },
          { latitude: Number(assayer.homeLatitude), longitude: Number(assayer.homeLongitude) }
        );
        distanceKm = route?.distanceKm || 0;
      } catch (e) {
        // Routing unavailable — the quote below falls back to zero travel rather than
        // guessing a distance, so ops sees base fee only instead of a fabricated allowance.
        route = null;
      }
    }

    /**
     * Frozen beside `quotedDistanceKm` (below) so the row can always say how its kilometres
     * were measured. Same fallback rule as everywhere else: an unlabelled route is an estimate.
     */
    const quotedDistanceSource: 'OSRM' | 'ESTIMATE' | null = route ? (route.source ?? 'ESTIMATE') : null;

    // The client's own territorial rules, enforced on the write path rather than merely
    // influencing a score. Without this an operator could assign an assayer living beside the
    // branch they are auditing — exactly what the minimum-distance rule exists to prevent —
    // simply by using the single-branch flow instead of the day planner.
    const distancePolicy = this.constraintEvaluator.checkDistancePolicy(
      projectBranch.project?.client?.planningPreferences,
      distanceKm > 0 ? distanceKm : null,
    );
    if (!distancePolicy.passed) {
      throw new BadRequestException(distancePolicy.reason);
    }

    /**
     * An assayer travels to a town once, so the day is charged travel once.
     *
     * Every assignment used to be quoted full travel from the assayer's home, so two branches
     * on the same street on the same day each paid the whole journey — the client was billed
     * twice for one trip, and the day planner's own estimate (which charges a shared route
     * once, and says so) never matched the assignments the plan went on to create.
     *
     * The first assignment of a day carries the travel; later ones on that same date are quoted
     * base fee only. Ordering is by creation, so this is stable regardless of which branch is
     * assigned first.
     */
    let chargeableDistanceKm = distanceKm;
    if (scheduledDateObj) {
      const alreadyTravellingThatDay = await this.assignmentRepository.findOne({
        where: {
          assayerId: assayer.id,
          scheduledDate: scheduledDateObj,
          status: In(COMMITTED_ASSIGNMENT_STATUSES.concat(AssignmentStatus.PENDING)),
          isActive: true,
        },
      });
      if (alreadyTravellingThatDay) {
        chargeableDistanceKm = 0;
      }
    }

    // One calculator, one rate card. The free-commute allowance and per-km rate come from
    // the client's contract, not from a constant in this file. The branch's place lets the
    // transport rate card ground the travel component in what the journey actually costs —
    // by bus, own vehicle, whatever the desk has configured for that state — when rates exist.
    const quote = await this.feePolicyService.quote({
      assayerId: assayer.id,
      clientId: projectBranch.project?.clientId ?? null,
      configuration: projectBranch.project?.client?.configuration ?? undefined,
      distanceKm: chargeableDistanceKm,
      onDate: scheduledDateObj || new Date(),
      place: {
        state: projectBranch.branch?.state ?? null,
        region: projectBranch.branch?.region ?? null,
      },
      // The routed leg, so the rate card times road modes by the real drive — the same input
      // the planning screen's quote receives, so the mode (and therefore the fee) recommended
      // there is the one recorded here. On a deduped second branch `chargeableDistanceKm` is 0
      // and the rate card prices no journey at all, road leg or not.
      road: route && route.durationMinutes > 0
        // A route with no label came from something older than the labelled provider; the
        // only honest thing to call it is an estimate (the engine applies the same rule).
        ? { distanceKm: route.distanceKm, durationMinutes: route.durationMinutes, source: route.source ?? 'ESTIMATE' }
        : null,
    });
    const baseFee = quote.baseFee;
    calculatedTravelFee = quote.travelFee;

    if (resolvedProposedFee === undefined || resolvedProposedFee === null) {
      resolvedProposedFee = quote.total;
    } else {
      // A client-supplied fee is an operator override, not a free-form number. The Day Plan
      // screen sends its own `proposedFee`, and this branch used to accept it verbatim —
      // which is precisely how the two divergent formulas both reached the database. The
      // override is still honoured (ops genuinely negotiate), but it is now bounded, and
      // anything above the computed quote is recorded as a deliberate deviation rather
      // than silently becoming the price.
      const override = Number(resolvedProposedFee);
      if (!Number.isFinite(override) || override < 0) {
        throw new BadRequestException('Proposed fee must be a non-negative number.');
      }
      const ceiling = quote.total * 2;
      if (override > ceiling) {
        throw new BadRequestException(
          `Proposed fee ₹${override} exceeds twice the contracted quote (₹${quote.total}) for this branch and assayer. ` +
          `Raise the client's rate card if this is intended.`,
        );
      }
      resolvedProposedFee = override;
    }

    /**
     * The same date check every other caller makes.
     *
     * This used to call `checkHoliday(state, date)` with **no clientId**, while all six other
     * callers pass one. Without it `isHoliday` cannot read the client's contracted working days
     * and falls back to Sunday + 2nd/4th Saturday — and since every client is created with
     * `workingDays: [1..5]`, the 1st, 3rd and 5th Saturday were closed everywhere in the system
     * except here. An operator could book a Saturday, the offer would go out, the assayer would
     * accept, and the audit could then never be scheduled: every later step passes the clientId
     * and refuses the date. It also dropped the client filter on the holiday rows themselves,
     * matching *other clients'* private holidays.
     *
     * `checkDateAvailability` is that check, and it also brings the two this path was missing
     * entirely — approved leave and the project timeline — which `update()` and `scheduleAudit()`
     * have always run.
     */
    if (scheduledDateObj) {
      const availability = await this.constraintEvaluator.checkDateAvailability({
        assayer,
        assayerId: dto.assayerId,
        project: projectBranch.project ?? null,
        branchState: projectBranch.branch.state,
        clientId: projectBranch.project?.clientId ?? null,
        scheduledDate: scheduledDateObj,
      });
      if (!availability.passed) {
        throw new BadRequestException(availability.reason);
      }

      // Kept separate: double-booking is a ConflictException (409), which the desk UI renders as
      // "already booked" rather than as an invalid date.
      const doubleBookingCheck = await this.constraintEvaluator.checkDoubleBooking(dto.assayerId, scheduledDateObj);
      if (!doubleBookingCheck.passed) {
        throw new ConflictException(doubleBookingCheck.reason);
      }
    }

    // Resolve SLA timeframe
    let maxResponseTimeHours = 24;
    if (projectBranch.project?.client?.configuration?.maxResponseTimeHours) {
      maxResponseTimeHours = Number(projectBranch.project.client.configuration.maxResponseTimeHours);
    }
    const slaDueDate = new Date();
    slaDueDate.setHours(slaDueDate.getHours() + maxResponseTimeHours);

    let assignment: AssignmentEntity;
    const isReassignment = Boolean(existingAssignment);

    if (existingAssignment) {
      // Reuse existing assignment record for this branch to preserve single unified timeline
      assignment = existingAssignment;
      assignment.assayerId = dto.assayerId;
      assignment.status = AssignmentStatus.PENDING;
      assignment.proposedFee = resolvedProposedFee;
      assignment.agreedFee = null;
      assignment.scheduledDate = scheduledDateObj;
      assignment.cancelReason = null;
      assignment.rejectReason = null;
      assignment.completionDate = null;
      assignment.syncToken = `SYNC-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      assignment.slaDueDate = slaDueDate;
      assignment.slaStatus = 'COMPLIANT';
      // Reset per-assayer evidence and negotiation state. Reusing the record for a NEW assayer
      // must not carry over the previous assayer's GPS check-in (which would read as this
      // assayer having stood in the branch — falsified audit evidence) or their spent
      // negotiation rounds (which would auto-decline a fresh offer prematurely).
      assignment.checkInLatitude = null;
      assignment.checkInLongitude = null;
      assignment.checkInAccuracyMeters = null;
      assignment.checkInDistanceMeters = null;
      assignment.checkedInAt = null;
      assignment.negotiationCount = 0;
      // The previous assayer's countered travel must die with their offer: assignmentMoney
      // prefers counterTravelFee over the frozen quote, so a stale one re-carves the NEW
      // assayer's payable (their base shrinks by a journey they never negotiated) and, with
      // rechargeTravel on, bills the client for it too.
      assignment.counterTravelFee = null;
      assignment.priority = projectBranch.priority;
      // The quote behind THIS offer, for this assayer. The previous assayer's breakdown must
      // not survive the reuse — their home, their distance, their rate card.
      assignment.quotedDistanceKm = distanceKm > 0 ? Number(distanceKm.toFixed(2)) : null;
      assignment.quotedDistanceSource = distanceKm > 0 ? quotedDistanceSource : null;
      assignment.quotedBaseFee = quote.baseFee;
      assignment.quotedTravelFee = quote.travelFee;
      assignment.quotedTransportMode = quote.transport?.recommended?.mode ?? null;
      assignment.updatedBy = userId;
      assignment.isActive = true;
    } else {
      assignment = this.assignmentRepository.create({
        // Allocated from the database sequence inside the transaction below — see
        // nextAssignmentNumber. Placeholder here only so the entity type-checks.
        assignmentNumber: '',
        projectBranchId: projectBranch.id,
        assessmentId: assessment?.id || null,
        projectId: projectBranch.projectId,
        assayerId: dto.assayerId,
        status: AssignmentStatus.PENDING,
        priority: projectBranch.priority,
        proposedFee: resolvedProposedFee,
        agreedFee: null,
        // What the calculator said this job should cost, kept alongside what was actually
        // offered. Negotiation moves proposedFee/agreedFee; these stay put, so "what did we
        // recommend vs what did we agree" remains answerable forever — and the travel figure
        // and distance are what expense review and travel verification later compare against.
        quotedDistanceKm: distanceKm > 0 ? Number(distanceKm.toFixed(2)) : null,
        quotedDistanceSource: distanceKm > 0 ? quotedDistanceSource : null,
        quotedBaseFee: quote.baseFee,
        quotedTravelFee: quote.travelFee,
        quotedTransportMode: quote.transport?.recommended?.mode ?? null,
        scheduledDate: scheduledDateObj,
        autoSchedule: dto.autoSchedule ?? true,
        syncToken: `SYNC-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
        slaDueDate,
        slaStatus: 'COMPLIANT',
        remarks: dto.remarks ?? null,
        createdBy: userId,
        updatedBy: userId,
      });
    }

    return this.uow.run(async (manager, emit) => {
      if (projectBranch && !projectBranch.scheduledDate && scheduledDateObj) {
        projectBranch.scheduledDate = scheduledDateObj;
        await manager.save(projectBranch);
      }
      if (!isReassignment) {
        assignment.assignmentNumber = await this.nextAssignmentNumber(manager);
      }
      const savedAssignment = await manager.save(assignment);

      // Update ProjectBranch status to PLANNING (or appropriate transitional state)
      await this.projectService.initiateBranchPlanning(projectBranch.id, userId, manager);

      await this.auditService.recordEventSafe({
        category: EventCategory.OPERATIONAL,
        eventType: isReassignment ? 'ASSIGNMENT_REASSIGNED' : 'ASSIGNMENT_CREATED',
        entityType: 'ASSIGNMENT',
        entityId: savedAssignment.id,
        userId,
        // The resolved fee and date, not the raw dto: both are optional on the request and the
        // server computes them when omitted, so reading dto here wrote "Fee: ₹undefined,
        // Date: undefined" into the audit record for every assignment that did not name its own
        // — which is most of them, including every one the coverage plan deploys.
        remarks: isReassignment
          ? `Reassigned branch ${projectBranch.branch.name} to assayer ${assayer.displayName}. Proposed fee: ₹${resolvedProposedFee}, Date: ${targetDateStr}.`
          : `Created assignment offer for branch ${projectBranch.branch.name}. Fee: ₹${resolvedProposedFee}, Date: ${targetDateStr}.`,
      }, { manager });

      // Through the outbox rather than a post-commit publish: the event now commits with the
      // assignment and is redelivered if the process dies before it reaches the gateway. The
      // try/catch this replaces could only log a lost event, never recover it.
      emit('assignment:created', {
        eventType: 'assignment:created',
        assignmentId: savedAssignment.id,
        assignmentNumber: savedAssignment.assignmentNumber,
        assayerId: savedAssignment.assayerId,
        organizationId: (savedAssignment as any).projectBranch?.project?.organizationId,
        branchName: projectBranch.branch?.name,
        status: savedAssignment.status,
      });

      return savedAssignment;
    }).then(async (saved) => {
      const branchName = projectBranch.branch?.name ?? 'the branch';
      // `targetDateStr`, not `dto.scheduledDate`: the date is optional on the request and falls
      // back to the branch's own scheduled date. An offer that read "on a date to be confirmed"
      // when a real date had been resolved gave the assayer nothing to plan around.
      const scheduledDateLabel = targetDateStr;

      // The offer notification.
      //
      // This previously tried to find a `users` row matching the assayer's
      // email and notify that — but assayers authenticate from the `assayers`
      // table and have no `users` row at all (0 of 25 match), so the in-app
      // half of this never fired once. The push half went out separately with
      // no record that it had, so a missed offer left no trace either way.
      // Both channels now go through one emit against the assayer's own id,
      // and the row records whether it actually arrived.
      //
      // Stays outside the transaction on purpose: NotificationDispatchService is Bull-backed
      // and has its own durability, and a notification is a side effect of the offer, not part
      // of its atomic write.
      const notifyOffered = () => this.notificationDispatch.emitSafe({
        type: 'ASSIGNMENT_OFFERED',
        entityType: 'ASSIGNMENT',
        entityId: saved.id,
        actorUserId: userId,
        assayerId: assayer.id,
        ownerUserId: userId,
        dedupeKey: `ASSIGNMENT_OFFERED:${saved.id}`,
        payload: {
          assignmentId: saved.id,
          assignmentNumber: saved.assignmentNumber,
          branchName,
          scheduledDate: scheduledDateLabel,
          proposedFee: resolvedProposedFee,
        },
      });

      if (!dto.acceptOnBehalf) {
        notifyOffered();
        return saved;
      }

      // Desk-confirmed (phone channel): the assayer agreed on the call, so there is no offer
      // for them to weigh up. Run the real ACCEPTED transition rather than writing the status
      // directly — that is what sets the agreed fee, moves the branch to ASSIGNMENT_CONFIRMED,
      // creates the calendar dispatch packet when autoSchedule is on, and writes the audit
      // event. Duplicating any of that here is how the two would drift apart.
      try {
        const { saved: accepted } = await this.executeAssignmentTransition(
          saved.id,
          AssignmentStatus.ACCEPTED,
          userId,
          dto.acceptanceReason?.trim() ||
            'Assayer agreed on the call — acceptance recorded by the desk at the time of assignment.',
          resolvedProposedFee ?? undefined,
          // One notification for this, not the offer/accept pair: ASSIGNMENT_OFFERED would tell
          // the assayer to "accept or decline" something already accepted, and ASSIGNMENT_ACCEPTED
          // would tell the rest of ops that the assayer accepted it in the app. Neither is true.
          { suppressNotification: true },
        );

        this.notificationDispatch.emitSafe({
          type: 'ASSIGNMENT_DESK_CONFIRMED',
          entityType: 'ASSIGNMENT',
          entityId: accepted.id,
          actorUserId: userId,
          assayerId: assayer.id,
          ownerUserId: userId,
          dedupeKey: `ASSIGNMENT_DESK_CONFIRMED:${accepted.id}`,
          payload: {
            assignmentId: accepted.id,
            assignmentNumber: accepted.assignmentNumber,
            assayerName: assayer.displayName ?? 'The assayer',
            branchName,
            scheduledDate: scheduledDateLabel,
            agreedFee: accepted.agreedFee ?? resolvedProposedFee,
          },
        });

        return accepted;
      } catch (err) {
        // The assignment itself committed; only the confirmation on top of it failed. Leaving it
        // PENDING is the honest outcome — it is a live offer that the desk can accept from the
        // Operations Inbox — so notify the assayer as one and let the caller see the real status
        // rather than reporting a confirmation that did not happen.
        AssignmentService.logger.error(
          `Assignment ${saved.assignmentNumber} was created but could not be desk-confirmed; it remains a PENDING offer. ` +
            `Reason: ${err instanceof Error ? err.message : String(err)}`,
        );
        notifyOffered();
        // Re-read rather than returning `saved`: a failed transition may have mutated its own
        // in-memory copy to ACCEPTED before throwing, and the caller decides what to tell the
        // operator from this status. It must be what committed, not what was attempted.
        return this.findOne(saved.id).catch(() => saved);
      }
    });
  }

  async findOne(id: string): Promise<AssignmentEntity> {
    const assignment = await this.assignmentRepository.findOne({
      where: { id },
      relations: ['projectBranch', 'projectBranch.branch', 'assayer'],
    });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${id} not found.`);
    }
    return assignment;
  }

  async update(id: string, dto: UpdateAssignmentDetailsDto, userId: string): Promise<AssignmentEntity> {
    const assignment = await this.findOne(id);

    if (assignment.status !== AssignmentStatus.PENDING) {
      throw new BadRequestException(
        `Locked: Cannot modify assignment details in status ${assignment.status}.`
      );
    }

    if (dto.proposedFee !== undefined) assignment.proposedFee = dto.proposedFee;
    if (dto.agreedFee !== undefined) assignment.agreedFee = dto.agreedFee;
    if (dto.scheduledDate !== undefined) {
      // Same gate as scheduleAudit and assignment creation. This used to check holidays only,
      // and via HolidayService directly rather than the evaluator, so an edit here could put an
      // assayer on a date they were on leave for or already committed to.
      const scheduledDateObj = new Date(dto.scheduledDate);
      const projectForDate = assignment.projectBranch?.projectId
        ? await this.dataSource.getRepository(ProjectEntity).findOne({ where: { id: assignment.projectBranch.projectId } })
        : null;
      const availability = await this.constraintEvaluator.checkDateAvailability({
        assayer: assignment.assayer ?? null,
        assayerId: assignment.assayerId,
        project: projectForDate,
        branchState: assignment.projectBranch?.branch?.state || assignment.assessment?.branch?.state || null,
        clientId: projectForDate?.clientId ?? null,
        scheduledDate: scheduledDateObj,
        excludeAssignmentId: assignment.id,
      });
      if (!availability.passed) {
        throw new BadRequestException(availability.reason);
      }
      assignment.scheduledDate = scheduledDateObj;
    }
    if (dto.remarks !== undefined) assignment.remarks = dto.remarks;
    assignment.updatedBy = userId;

    const saved = await this.assignmentRepository.save(assignment);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_UPDATED',
      entityType: 'ASSIGNMENT',
      entityId: saved.id,
      userId,
      remarks: `Updated details for assignment ${saved.assignmentNumber}.`,
    });

    try {
      if (dto.proposedFee !== undefined || dto.agreedFee !== undefined) {
        this.eventPublisher.publish('assignment:fee-updated', {
          eventType: 'assignment:fee-updated',
          assignmentId: saved.id,
          assignmentNumber: saved.assignmentNumber,
          proposedFee: saved.proposedFee,
          agreedFee: saved.agreedFee,
          assayerId: saved.assayerId,
          organizationId: (saved as any).projectBranch?.project?.organizationId,
          userId,
          timestamp: new Date(),
        });
      }
    } catch (err) {
      console.error('Failed to publish assignment:fee-updated event:', err);
    }

    return saved;
  }

  private async executeAssignmentTransition(
    id: string,
    targetStatus: AssignmentStatus,
    userId: string,
    reason?: string,
    fee?: number,
    /**
     * `suppressNotification` withholds only the lifecycle notification — the state change, the
     * audit event and the domain event all still happen. Used by the desk-confirmed create path,
     * which sends one accurate notification of its own in place of the offer/accept pair.
     */
    options?: { suppressNotification?: boolean },
  ): Promise<{ saved: AssignmentEntity; event: any }> {
    const assignment = await this.findOne(id);
    const prevStatus = assignment.status;

    if (prevStatus === targetStatus && fee === undefined) {
      /**
       * Already in the target state: nothing to transition, so the state machine is not run again.
       *
       * A supplied reason is still worth keeping, though. Re-declining with a corrected reason used
       * to return 201 and silently drop the correction — the caller was told it had worked while
       * the original text (often the bare default "Rejected") stayed on the record. Persist it, so
       * "success" and "saved" mean the same thing.
       */
      const trimmed = reason?.trim();
      if (trimmed) {
        if (targetStatus === AssignmentStatus.REJECTED && assignment.rejectReason !== trimmed) {
          assignment.rejectReason = trimmed;
          assignment.updatedBy = userId;
          return { saved: await this.assignmentRepository.save(assignment), event: null };
        }
        if (targetStatus === AssignmentStatus.CANCELLED && assignment.cancelReason !== trimmed) {
          assignment.cancelReason = trimmed;
          assignment.updatedBy = userId;
          return { saved: await this.assignmentRepository.save(assignment), event: null };
        }
      }
      return { saved: assignment, event: null };
    }

    let event: any;
    let pbEvent: any;
    if (targetStatus === AssignmentStatus.ACCEPTED) {
      if (prevStatus !== targetStatus) {
        event = AssignmentStateMachine.acceptOffer(assignment, userId);
        /**
         * Acceptance answers the RESPONSE clock, so the SLA is re-armed to measure the next
         * thing that can actually be late: attending the visit. Left alone, `slaDueDate` kept
         * its created+24h value forever — every assignment accepted more than a day ago was
         * flagged BREACHED by the scanner (permanently: nothing resets slaStatus), and the
         * falling-behind board ranked a healthy assignment accepted 30 days ago for next month
         * above a genuine no-show from yesterday. The new deadline is the end of the scheduled
         * day, IST; unscheduled work has no deadline until the desk gives it a date.
         */
        assignment.slaDueDate = assignment.scheduledDate
          ? new Date(`${businessDateKey(assignment.scheduledDate)}T23:59:59+05:30`)
          : null;
        assignment.slaStatus = 'COMPLIANT';
      }
      if (fee !== undefined && fee !== null) {
        assignment.proposedFee = fee;
        assignment.agreedFee = fee;
      } else if (!assignment.agreedFee && assignment.proposedFee) {
        assignment.agreedFee = assignment.proposedFee;
      }
      if (assignment.projectBranch && assignment.projectBranch.status !== ProjectBranchStatus.ASSIGNMENT_CONFIRMED) {
        pbEvent = ProjectBranchStateMachine.confirmAssignment(assignment.projectBranch, userId);
      }
      /**
       * Auto-scheduling on acceptance, through the same gate the scheduling desk passes.
       *
       * This wrote a CONFIRMED `schedules` row directly — via a string-keyed generic repository,
       * skipping `checkDateAvailability` entirely. So an assayer accepting an offer produced a
       * confirmed dispatch on a day they were on leave, on a client holiday, or outside the
       * project timeline: every condition that check exists to catch. It left no
       * SCHEDULE_CONFIRMED audit row and sent no dispatch notification, so the assayer was never
       * told and the dispatch had no evidence trail. And because it ran by default
       * (`autoSchedule ?? true`), it was the path almost every schedule actually took — while
       * `SchedulingService.create`, the one with the checks, became a no-op update.
       *
       * The check now runs first. If the date is not available the assignment still accepts —
       * the assayer's acceptance is real and must not be undone by a calendar clash — but no
       * schedule is written, and the reason is recorded so the desk can place it deliberately.
       */
      if (assignment.autoSchedule !== false && assignment.scheduledDate) {
        await this.autoScheduleOnAcceptance(assignment, userId);
      }
    } else if (targetStatus === AssignmentStatus.REJECTED) {
      event = AssignmentStateMachine.rejectOffer(assignment, userId, reason);
      if (assignment.projectBranch) {
        assignment.projectBranch.status = ProjectBranchStatus.CANDIDATE_SEARCH;
      }
    } else if (targetStatus === AssignmentStatus.CANCELLED) {
      event = AssignmentStateMachine.cancel(assignment, userId, reason);
      if (assignment.projectBranch) {
        assignment.projectBranch.status = ProjectBranchStatus.CANDIDATE_SEARCH;
      }
    } else if (targetStatus === AssignmentStatus.COMPLETED) {
      // Refuses completion of work that was never accepted, and refuses closing an unattended
      // job without a stated reason — see AssignmentStateMachine.completeAudit.
      event = AssignmentStateMachine.completeAudit(assignment, userId, reason);
      assignment.completionDate = new Date();
      if (assignment.projectBranch && assignment.projectBranch.status !== ProjectBranchStatus.AUDIT_COMPLETED) {
        pbEvent = ProjectBranchStateMachine.completeAudit(assignment.projectBranch, userId);
      }
      // The matching schedule row is brought to COMPLETED inside the transaction below,
      // via syncScheduleCompletion(). It used to happen here instead, as raw SQL issued on
      // `this.dataSource` — outside the transaction that saves the assignment, and with
      // `.catch(err => console.error(...))` swallowing any failure. Two consequences, both
      // real: if the assignment save below rolled back, the schedule was already COMPLETED
      // and stayed that way; and if the upsert itself failed, nothing surfaced it, leaving
      // `schedules.status` and `assignments.status` silently disagreeing about the same job.
    } else {
      throw new BadRequestException(`Invalid assignment status transition to ${targetStatus}`);
    }

    assignment.updatedBy = userId;


    const saved = await this.uow.run(async (manager, emit) => {
      /**
       * The compare-and-swap that makes concurrent transitions safe.
       *
       * The row was read and mutated OUTSIDE this transaction with no lock, so two callers —
       * ops cancelling while the assayer accepts — could both read PENDING and both commit,
       * last write winning: an "accepted" assignment whose schedule was already retired and
       * whose cancellation was already announced, or a completion racing a cancellation after
       * billing has booked the payable (and billing has no reversal path). Locking the row here
       * and re-asserting the state we transitioned FROM turns the blind overwrite into an
       * explicit conflict for the loser. Bare row, no relations — FOR UPDATE cannot span an
       * outer join.
       */
      const lockedRows: Array<{ status: string }> = await manager.query(
        'SELECT status FROM assignments WHERE id = $1 FOR UPDATE',
        [id],
      );
      const lockedStatus = lockedRows?.[0]?.status;
      if (!lockedStatus) throw new NotFoundException(`Assignment ${id} not found`);
      if (lockedStatus !== prevStatus && lockedStatus !== targetStatus) {
        throw new ConflictException(
          `This assignment changed while you were acting on it — it is now '${lockedStatus}'. Refresh and try again.`,
        );
      }

      if (assignment.projectBranch) {
        await manager.save(assignment.projectBranch);
      }
      if (assignment.assessment) {
        await manager.save(assignment.assessment);
      }
      const savedAssign = await manager.save(assignment);

      if (targetStatus === AssignmentStatus.COMPLETED) {
        // Inside the transaction: either both the assignment and its schedule reach
        // COMPLETED, or neither does.
        await this.syncScheduleCompletion(savedAssign, userId, manager);
      } else if (
        targetStatus === AssignmentStatus.CANCELLED ||
        targetStatus === AssignmentStatus.REJECTED
      ) {
        // Same transaction, same reason: the branch goes back to needing an assayer above, so
        // its calendar entry must go with it or the two disagree.
        await this.retireSchedule(savedAssign, userId, manager);
      }

      await this.auditService.recordEventSafe({
        category: EventCategory.WORKFLOW,
        eventType: `ASSIGNMENT_${targetStatus}`,
        entityType: 'ASSIGNMENT',
        entityId: savedAssign.id,
        previousState: prevStatus,
        newState: targetStatus,
        userId,
        remarks: reason ?? `Transitioned assignment to ${targetStatus}`,
      }, { manager });

      // The status change is emitted through the outbox from inside the transaction, so it
      // commits atomically with the transition and survives a crash before delivery.
      //
      // This is the event billing's auto-bill listener consumes: a COMPLETED assignment that
      // committed but whose event was published post-commit by the raw publisher (as it was
      // before) would, if the process died in that window, never be billed and never create an
      // assayer payable — completed work, no invoice, no trace. Routing it here closes that.
      // Delivery is at-least-once; the billing listener is already idempotent (its
      // already-billed guards plus a Redis lock), which is the precondition for moving it here.
      if (event) {
        emit('assignment:status-changed', {
          eventType: 'assignment:status-changed',
          assignmentId: savedAssign.id,
          assignmentNumber: savedAssign.assignmentNumber,
          previousState: event.previousState || prevStatus,
          newState: savedAssign.status,
          assayerId: savedAssign.assayerId,
          organizationId: (savedAssign as any).projectBranch?.project?.organizationId,
          userId: event.userId,
          metadata: event.metadata,
        });
      }

      // The project-branch transition rides the same transaction. No named subscriber depends
      // on it being a class instance — only the realtime gateway's broadcast — so a plain
      // payload is equivalent and is what the outbox stores.
      if (pbEvent) {
        emit(pbEvent.constructor.name, { ...pbEvent });
      }

      return savedAssign;
    });

    // Notifications.
    //
    // These used to go to `saved.createdBy` alone — the one person who happened
    // to raise the offer. If they were on leave, a rejection that needs a
    // same-day replacement reached nobody. Routing through the catalog sends it
    // to whoever currently holds the operations roles instead, so cover follows
    // the org chart rather than a stale user id.
    // Cancellation is wired here rather than in cancelAssignment(): every cancel path — the
    // controller, and anything else reaching for the state machine — funnels through this
    // transition, so one emit here fires exactly once per commit and cannot fire on a rolled
    // back cancel. The assayer is a recipient (ASSIGNED_ASSAYER) because a cancelled job simply
    // disappears from their next fetch, with no other signal that it is gone.
    const notifyType =
      targetStatus === AssignmentStatus.ACCEPTED ? 'ASSIGNMENT_ACCEPTED'
      : targetStatus === AssignmentStatus.REJECTED ? 'ASSIGNMENT_REJECTED'
      : targetStatus === AssignmentStatus.CANCELLED ? 'ASSIGNMENT_CANCELLED'
      : null;

    if (notifyType && !options?.suppressNotification) {
      this.notificationDispatch.emitSafe({
        type: notifyType,
        entityType: 'ASSIGNMENT',
        entityId: saved.id,
        actorUserId: userId,
        assayerId: saved.assayerId,
        ownerUserId: saved.createdBy,
        // Status is part of the key so a later transition on the same
        // assignment is a new notification rather than a suppressed duplicate.
        dedupeKey: `${notifyType}:${saved.id}:${targetStatus}`,
        payload: {
          assignmentId: saved.id,
          assignmentNumber: saved.assignmentNumber,
          assayerName: assignment.assayer
            ? `${assignment.assayer.firstName} ${assignment.assayer.lastName}`.trim()
            : 'The assayer',
          branchName: assignment.projectBranch?.branch?.name ?? saved.assignmentNumber,
          reason: reason ?? 'No reason given',
          scheduledDate: saved.scheduledDate
            ? new Date(saved.scheduledDate).toISOString().slice(0, 10)
            : 'the scheduled date',
        },
      });
    }

    if (targetStatus === AssignmentStatus.COMPLETED) {
      try {
        if (saved.projectBranchId) {
          // getOrCreateForBranch (not create) so completion is idempotent: if a case
          // already exists for this branch — data-entry delegation opened one, or a
          // re-delivered completion event — it is reused rather than duplicated.
          await this.validationService.getOrCreateForBranch(
            saved.projectBranchId,
            saved.assessmentId ?? null,
            userId,
          );
        }
      } catch (err) {
        console.error('Failed to auto-create validation case on completion:', err);
      }
    }

    /**
     * Taking on work turns location sharing on.
     *
     * The obligation and the job begin together: from here until the assignment completes, the
     * movement trail is what will confirm the travel this assayer is paid for, and sharing they
     * could leave off for the journey they are about to claim for would make that unverifiable.
     * `setLiveTracking` enforces the other half — they cannot switch it back off while the work is
     * still open — and both ends stop at completion, so nothing follows anyone into their own time.
     *
     * Best-effort inside the service: losing an acceptance because a flag would not flip is a far
     * worse outcome than a trail that starts late, and a late start is visible in the assessment.
     */
    if (targetStatus === AssignmentStatus.ACCEPTED) {
      await this.assayerService.enableLiveTrackingForActiveWork(saved.assayerId, userId);
    } else if (
      saved.assayerId
      && (targetStatus === AssignmentStatus.COMPLETED
        || targetStatus === AssignmentStatus.CANCELLED
        || targetStatus === AssignmentStatus.REJECTED)
    ) {
      // The other half of the promise above: when the job ends and no other committed work
      // remains, sharing stops. Best-effort for the same reason the enable is.
      await this.assayerService.disableLiveTrackingWhenWorkEnds(saved.assayerId, userId);
    }

    // Off the critical path. These are cached counters for roster listings and reports — nothing
    // in this response reads them — and awaiting the recompute here made every accept, reject,
    // cancel and complete wait on a fan of statistics queries before returning. `getProfile`
    // recomputes on read, so a momentarily stale counter corrects itself where it is looked at.
    this.assayerService.scheduleStatsRefresh(saved.assayerId);

    return { saved, event };
  }

  /**
   * A counter-offer is about the journey, not the audit fee.
   *
   * The fee is what the work is worth and comes from the rate card; neither the assayer nor the
   * desk sets it. What varies is the travel — how far, by what, and at whose cost — so
   * `counterTravelFee` is what moves, and the total follows it.
   *
   * This used to take the whole fee. `assignmentMoney` then carved travel back out at the frozen
   * quoted figure, so every rupee negotiated landed in the *base* — silently repricing the audit
   * instead of the journey, and leaving the payable's base disagreeing with the rate card that
   * produced it.
   *
   * The total is kept in step here rather than derived at read time, because `proposedFee` is
   * what the mobile app shows the assayer and what the payable is built from: those must agree
   * with each other and with the travel figure beside them.
   */
  async proposeCounterFee(id: string, userId: string, counterTravelFee: number, remarks?: string): Promise<AssignmentEntity> {
    const assignment = await this.findOne(id);
    // A counter-offer only makes sense while the offer is still open. Without this guard it could
    // mutate proposedFee on a COMPLETED assignment (diverging from what was already billed) or
    // re-open a CANCELLED/CHECKED_IN branch by flipping it back to NEGOTIATION.
    if (assignment.status !== AssignmentStatus.PENDING) {
      throw new BadRequestException(
        `A counter-offer can only be made on an open offer (PENDING), not '${assignment.status}'.`,
      );
    }
    const currentCount = assignment.negotiationCount || 0;
    const maxRounds = await this.settings
      .getNumber('field.maxNegotiationRounds', DEFAULT_MAX_NEGOTIATION_ROUNDS)
      .catch(() => DEFAULT_MAX_NEGOTIATION_ROUNDS);
    if (currentCount >= maxRounds) {
      /**
       * Routed through the SAME transition pipeline a manual decline takes — this used to be a
       * bespoke save that flipped the status and told the notification bus, but skipped
       * everything else the pipeline does: no ASSIGNMENT_REJECTED audit event (the timeline
       * showed counter-offers 1..N and then silence), no `assignment:status-changed` realtime
       * emit (neither the ops board nor the assayer's phone updated live), no schedule
       * retirement, no stats refresh. One decline path, whoever triggers it.
       */
      return this.rejectOffer(
        id,
        userId,
        `Negotiation limit reached (${maxRounds} counter-offers max). Offer auto-declined.`,
      );
    }
    // Captured before the overwrite: a negotiation's audit value is the movement.
    const previousFee = assignment.proposedFee;
    const previousTravel = assignment.counterTravelFee ?? assignment.quotedTravelFee;

    /**
     * The audit fee the rate card set, which a counter-offer does not touch.
     *
     * Taken from the quote where there is one. An offer made before the quote columns existed
     * has none, and for those the previous total less its travel is the best available reading of
     * what the base was — the same arithmetic `assignmentMoney` has always applied.
     */
    const quotedTravel = Number(assignment.quotedTravelFee ?? 0);
    const baseFee = assignment.quotedBaseFee !== null && assignment.quotedBaseFee !== undefined
      ? Number(assignment.quotedBaseFee)
      : Math.max(0, Number(previousFee ?? 0) - quotedTravel);

    assignment.negotiationCount = currentCount + 1;
    assignment.counterTravelFee = counterTravelFee;
    assignment.proposedFee = Math.round((baseFee + counterTravelFee) * 100) / 100;
    assignment.remarks = remarks
      ?? `Counter offer #${assignment.negotiationCount}: travel ₹${counterTravelFee} `
         + `(audit fee ₹${baseFee} unchanged)`;
    assignment.updatedBy = userId;
    if (assignment.projectBranch) {
      assignment.projectBranch.status = ProjectBranchStatus.NEGOTIATION;
    }
    const saved = await this.dataSource.transaction(async (manager) => {
      if (assignment.projectBranch) {
        await manager.save(assignment.projectBranch);
      }
      return manager.save(assignment);
    });

    /**
     * A counter-offer changes what this audit will cost, so it is a money decision and needs
     * a record. Nothing was written here: the assignment kept only the latest proposedFee, so
     * a negotiation that moved 1,200 -> 1,800 -> 1,500 left one number and no history of how
     * it got there or who moved it.
     */
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_COUNTER_OFFERED',
      entityType: 'ASSIGNMENT',
      entityId: saved.id,
      userId,
      // The movement that matters is the travel figure. The total is recorded beside it because
      // that is what the payable is built from, but it moved only because travel did.
      remarks: `Counter offer #${saved.negotiationCount}: travel ₹${previousTravel ?? 'unset'} → `
        + `₹${counterTravelFee} (total ₹${previousFee ?? 'unset'} → ₹${saved.proposedFee}).`,
      metadata: {
        previousTravelFee: previousTravel ?? null,
        counterTravelFee,
        previousFee: previousFee ?? null,
        proposedFee: saved.proposedFee,
        negotiationRound: saved.negotiationCount,
        assayerId: saved.assayerId,
      },
    });

    // The round number is in the dedupe key: each counter-offer is a fresh price ops must
    // answer, so round 2 must not be swallowed as a duplicate of round 1.
    this.notificationDispatch.emitSafe({
      type: 'ASSIGNMENT_COUNTER_OFFERED',
      entityType: 'ASSIGNMENT',
      entityId: saved.id,
      actorUserId: userId,
      assayerId: saved.assayerId,
      ownerUserId: saved.createdBy,
      dedupeKey: `ASSIGNMENT_COUNTER_OFFERED:${saved.id}:${saved.negotiationCount}`,
      payload: {
        assignmentId: saved.id,
        assignmentNumber: saved.assignmentNumber,
        assayerName: assignment.assayer
          ? `${assignment.assayer.firstName} ${assignment.assayer.lastName}`.trim()
          : 'The assayer',
        proposedFee: saved.proposedFee,
        counterTravelFee,
        branchName: assignment.projectBranch?.branch?.name ?? saved.assignmentNumber,
        reason: remarks ?? 'No reason given',
      },
    });

    try {
      this.eventPublisher.publish('assignment:counter-offered', {
        eventType: 'assignment:counter-offered',
        assignmentId: saved.id,
        assignmentNumber: saved.assignmentNumber,
        assayerId: saved.assayerId,
        proposedFee: saved.proposedFee,
        counterTravelFee,
        previousFee: previousFee ?? null,
        negotiationRound: saved.negotiationCount,
        // The phone receives this event and has to say something useful about it. Without a
        // branch name the only live text it could show was a generic "an assignment changed",
        // which tells an assayer holding several offers nothing about which one moved.
        branchName: assignment.projectBranch?.branch?.name ?? saved.assignmentNumber,
        projectBranchId: saved.projectBranchId,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish counter offer event', err);
    }

    return saved;
  }

  async acceptOffer(id: string, userId: string, fee?: number, reason?: string): Promise<AssignmentEntity> {
    // The status-changed event is emitted inside executeAssignmentTransition's transaction now
    // (through the outbox), so callers no longer publish it afterwards.
    const { saved } = await this.executeAssignmentTransition(id, AssignmentStatus.ACCEPTED, userId, reason, fee);
    return saved;
  }

  async rejectOffer(id: string, userId: string, reason?: string): Promise<AssignmentEntity> {
    const { saved } = await this.executeAssignmentTransition(id, AssignmentStatus.REJECTED, userId, reason);
    return saved;
  }

  async cancelAssignment(id: string, userId: string, reason?: string): Promise<AssignmentEntity> {
    const { saved } = await this.executeAssignmentTransition(id, AssignmentStatus.CANCELLED, userId, reason);
    return saved;
  }

  /**
   * Complete an assignment — sets completionDate, transitions branch to AUDIT_COMPLETED,
   * and auto-creates a validation case. Called when a schedule is marked COMPLETED.
   * This is the AUDIT workflow completion — separate from query/validation workflow.
   */
  async completeAssignment(id: string, userId: string, reason?: string): Promise<AssignmentEntity> {
    const { saved } = await this.executeAssignmentTransition(id, AssignmentStatus.COMPLETED, userId, reason);
    return saved;
  }

  /**
   * Manually flags an assignment as urgent by bumping its priority to CRITICAL —
   * the only manual escalation path today; the SLA scanner's auto-decline
   * (checkSlaBreaches/autoDeclineExpiredOffers) is the sole automatic one.
   * Reuses the existing `priority` column rather than adding a separate
   * escalated flag/status.
   */
  async escalate(id: string, userId: string, reason?: string): Promise<AssignmentEntity> {
    const assignment = await this.findOne(id);

    if (assignment.status === AssignmentStatus.COMPLETED) {
      throw new BadRequestException('Cannot escalate a completed assignment.');
    }

    const alreadyCritical = assignment.priority === Priority.CRITICAL;
    assignment.priority = Priority.CRITICAL;
    assignment.updatedBy = userId;
    const saved = await this.assignmentRepository.save(assignment);

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_ESCALATED',
      entityType: 'ASSIGNMENT',
      entityId: saved.id,
      userId,
      remarks: reason ?? `Assignment ${saved.assignmentNumber} escalated to CRITICAL priority.`,
    });

    // An escalation is precisely the case where notifying only the raiser is
    // wrong: it exists to pull in people who are not already watching. Goes to
    // operations *and* administrators.
    if (!alreadyCritical) {
      this.notificationDispatch.emitSafe({
        type: 'ASSIGNMENT_ESCALATED',
        entityType: 'ASSIGNMENT',
        entityId: saved.id,
        actorUserId: userId,
        ownerUserId: saved.createdBy,
        dedupeKey: `ASSIGNMENT_ESCALATED:${saved.id}`,
        payload: {
          assignmentId: saved.id,
          assignmentNumber: saved.assignmentNumber,
          branchName: assignment.projectBranch?.branch?.name ?? saved.assignmentNumber,
          reason: reason ?? 'No reason given.',
        },
      });
    }

    this.publishAssignmentEvent('assignment:escalated', saved, { userId, previousState: assignment.status, timestamp: new Date() });

    return saved;
  }

  /**
   * An assayer flags a problem on their own assignment to the operations desk.
   *
   * The field app deliberately cannot cancel or reassign work — those are back-office
   * decisions (see the transition controller). But before this the assayer had no way to tell
   * the desk anything on their own initiative either: queries are desk-initiated, escalation
   * is ops-only. So an assayer standing at a shut branch, or one who has fallen ill the morning
   * of an audit, could only phone someone — nothing was recorded, and the desk had no signal in
   * the system to act on.
   *
   * This is that missing signal. It changes no status and frees no branch; it records the flag,
   * notifies the assigning user and operations, and emits a realtime event so the desk can then
   * take the back-office action (reassign, reschedule, cancel) that remains theirs to take.
   */
  async reportIssue(
    id: string,
    userId: string,
    category: string,
    note?: string,
  ): Promise<AssignmentEntity> {
    const assignment = await this.findOne(id);

    if (assignment.status === AssignmentStatus.COMPLETED) {
      throw new BadRequestException('This assignment is already completed.');
    }

    const branchName = assignment.projectBranch?.branch?.name ?? assignment.assignmentNumber;
    const summary = `${assignmentIssueCategoryLabel(category)}${note ? `: ${note}` : ''}`;

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_ISSUE_REPORTED',
      entityType: 'ASSIGNMENT',
      entityId: assignment.id,
      userId,
      remarks: `Assayer flagged ${assignment.assignmentNumber} (${branchName}) — ${summary}`,
      // Structured so the desk's field-issues view can render category and note without
      // re-parsing the remarks string.
      metadata: {
        category,
        categoryLabel: assignmentIssueCategoryLabel(category),
        note: note ?? '',
        assignmentNumber: assignment.assignmentNumber,
        branchName,
      },
    });

    this.notificationDispatch.emitSafe({
      type: 'ASSIGNMENT_ISSUE_REPORTED',
      entityType: 'ASSIGNMENT',
      entityId: assignment.id,
      actorUserId: userId,
      ownerUserId: assignment.createdBy,
      // Not deduped on the assignment alone — an assayer may legitimately flag the same job
      // twice (branch shut, then a safety concern), and each must reach the desk.
      payload: {
        assignmentId: assignment.id,
        assignmentNumber: assignment.assignmentNumber,
        branchName,
        category,
        categoryLabel: assignmentIssueCategoryLabel(category),
        note: note ?? '',
      },
    });

    this.publishAssignmentEvent('assignment:issue-reported', assignment, {
      userId,
      previousState: assignment.status,
      timestamp: new Date(),
    });

    return assignment;
  }

  /**
   * The desk's list of problems the field has flagged.
   *
   * Read from the audit log rather than a bespoke table: `reportIssue` already records every
   * flag as an `ASSIGNMENT_ISSUE_REPORTED` event with the category and note in its metadata, so
   * this needs no new schema. The list is self-clearing — an issue is "open" only while its
   * assignment is still actionable; once the desk reassigns, reschedules or cancels the job (or
   * it completes), `open` flips to false and it drops out of the default filter. That makes the
   * assignment's own state the source of truth for "handled", with no separate resolve step to
   * forget.
   */
  async listFieldIssues(scope?: Partial<GlobalScope>, limit = 100): Promise<any[]> {
    const issueBranchWhere = branchScopeWhere(scope);
    const isScoped = Boolean(issueBranchWhere || scope?.projectId);

    // The audit log itself carries no region, so it is read org-wide and narrowed afterwards
    // by the assignments it points at. Under a scope most of that window will be discarded, so
    // widen the fetch — otherwise a West operator's 100 newest events might contain three of
    // their own and their issue list would look empty while the desk is busy.
    const fetchLimit = isScoped ? Math.min(limit * 10, 1000) : limit;
    const { events } = await this.auditService.getByEventType('ASSIGNMENT_ISSUE_REPORTED', fetchLimit);
    if (events.length === 0) return [];

    // Batch-load the referenced assignments so the current status/branch/assayer is fresh,
    // rather than trusting the point-in-time metadata — and without a query per event.
    const ids = Array.from(new Set(events.map((e) => e.entityId).filter(Boolean)));
    const issueWhere: Record<string, unknown> = { id: In(ids) };
    if (issueBranchWhere) issueWhere.projectBranch = { branch: issueBranchWhere };
    if (scope?.projectId) issueWhere.projectId = scope.projectId;

    const assignments = await this.assignmentRepository.find({
      where: issueWhere,
      relations: ['projectBranch', 'projectBranch.branch', 'assayer'],
    });
    const byId = new Map(assignments.map((a) => [a.id, a]));

    /**
     * Under a scope, an event whose assignment did not survive the scoped re-fetch is dropped
     * outright.
     *
     * This filter is the whole enforcement. Scoping only the re-fetch is not enough, because
     * the projection below deliberately falls back to the event's own point-in-time metadata
     * (`meta.branchName`, `meta.note`, `e.userDisplayName`) when the assignment is missing —
     * so without this line an out-of-scope issue still emitted the branch name, the assayer's
     * name, the issue category and the reporter's free-text note. The fallback exists for
     * assignments that have since been deleted, which is a different situation from ones the
     * caller is not entitled to see.
     */
    const visible = isScoped ? events.filter((e) => byId.has(e.entityId)) : events;

    return visible.slice(0, limit).map((e) => {
      const a = byId.get(e.entityId);
      const meta = (e.metadata ?? {}) as Record<string, any>;
      const open = !!a && !isAssignmentTerminal(a.status);
      return {
        id: e.id,
        reportedAt: e.occurredAt,
        assignmentId: e.entityId,
        assignmentNumber: a?.assignmentNumber ?? meta.assignmentNumber ?? null,
        branchName: a?.projectBranch?.branch?.name ?? meta.branchName ?? null,
        assayerName: a?.assayer?.displayName ?? e.userDisplayName ?? null,
        assayerId: a?.assayerId ?? null,
        category: meta.category ?? null,
        categoryLabel: meta.categoryLabel ?? null,
        note: meta.note ?? '',
        assignmentStatus: a?.status ?? null,
        open,
      };
    });
  }

  /**
   * Writes the acceptance-time schedule, or declines to and says why.
   *
   * `SchedulingService` cannot be injected here — it imports this module — so the shared piece is
   * `ConstraintEvaluator`, which is what both paths must agree on. The row itself is written
   * through the `schedules` repository with the same shape `SchedulingService.create` produces,
   * and the same audit event, so a schedule is indistinguishable whichever door it came through.
   */
  private async autoScheduleOnAcceptance(assignment: AssignmentEntity, userId: string): Promise<void> {
    const scheduledDateObj = new Date(assignment.scheduledDate as any);

    // try/catch, not `.catch()`: a synchronous throw here would escape a promise-only handler and
    // roll back an acceptance that has already legitimately happened. Whatever goes wrong while
    // checking the calendar, the assayer still accepted the job.
    let availability: { passed: boolean; reason?: string };
    try {
      availability = await this.constraintEvaluator.checkDateAvailability({
        assayer: assignment.assayer ?? null,
        assayerId: assignment.assayerId,
        project: assignment.project ?? null,
        branchState: assignment.projectBranch?.branch?.state ?? null,
        clientId: assignment.project?.clientId ?? null,
        scheduledDate: scheduledDateObj,
        excludeAssignmentId: assignment.id,
      });
    } catch (err) {
      availability = {
        passed: false,
        reason: `Availability could not be checked: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!availability.passed) {
      // Deliberately not thrown. The acceptance already happened and is correct; only the
      // calendar entry is in doubt. Recorded so the branch shows up on the desk as needing a
      // date rather than silently having none.
      AssignmentService.logger.warn(
        `Assignment ${assignment.assignmentNumber} accepted but not auto-scheduled: ${availability.reason}`,
      );
      await this.auditService.recordEventSafe({
        category: EventCategory.OPERATIONAL,
        eventType: 'SCHEDULE_AUTO_SKIPPED',
        entityType: 'ASSIGNMENT',
        entityId: assignment.id,
        userId,
        remarks: `Offer accepted, calendar entry withheld: ${availability.reason}`,
      });
      return;
    }

    const scheduleRepo = this.dataSource.getRepository(ScheduleEntity);
    const existing = await scheduleRepo
      .findOne({ where: { assignmentId: assignment.id, isActive: true } })
      .catch(() => null);
    if (existing) return;

    const saved = await scheduleRepo.save(
      scheduleRepo.create({
        assignmentId: assignment.id,
        projectId: assignment.projectId ?? null,
        assayerId: assignment.assayerId,
        scheduledDate: scheduledDateObj,
        status: ScheduleStatus.CONFIRMED,
        remarks: 'Auto-created upon offer acceptance (Direct Calendar Lock)',
        createdBy: userId,
        updatedBy: userId,
      } as any),
    );

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'SCHEDULE_CONFIRMED',
      entityType: 'SCHEDULE',
      entityId: (saved as any).id,
      userId,
      remarks: `Confirmed on acceptance of ${assignment.assignmentNumber}.`,
    });

    // The assayer is the one who has to show up; a dispatch they were never told about is not a
    // dispatch. `SchedulingService` sends this on its path, and this one sent nothing.
    this.notificationDispatch.emitSafe({
      type: 'SCHEDULE_DISPATCHED',
      entityType: 'SCHEDULE',
      entityId: (saved as any).id,
      actorUserId: userId,
      assayerId: assignment.assayerId,
      dedupeKey: `SCHEDULE_DISPATCHED:${(saved as any).id}`,
      payload: {
        assignmentId: assignment.id,
        assignmentNumber: assignment.assignmentNumber,
        scheduledDate: scheduledDateObj.toISOString(),
        branchName: assignment.projectBranch?.branch?.name ?? '',
      },
    });
  }

  async scheduleAudit(id: string, userId: string, scheduledDate: string, remarks?: string): Promise<AssignmentEntity> {
    const assignment = await this.findOne(id);

    /**
     * The single gate every scheduled-date write passes through.
     *
     * SchedulingService.create ran leave, timeline and holiday checks; SchedulingService
     * .transition (the Reschedule button) ran none; and this function, which both of them
     * funnel into, validated nothing. An audit could be moved onto a registered bank holiday
     * or onto a date the assayer was on leave or already booked, and it was written to
     * schedules, assignments, project_branches and assessments without objection. Guarding
     * the funnel closes every one of those paths at once.
     */
    const scheduledDateObj = new Date(scheduledDate);
    const project = assignment.projectBranch?.projectId
      ? await this.dataSource.getRepository(ProjectEntity).findOne({ where: { id: assignment.projectBranch.projectId } })
      : null;

    const availability = await this.constraintEvaluator.checkDateAvailability({
      assayer: assignment.assayer ?? null,
      assayerId: assignment.assayerId,
      project,
      branchState: assignment.projectBranch?.branch?.state ?? null,
      clientId: project?.clientId ?? null,
      scheduledDate: scheduledDateObj,
      excludeAssignmentId: assignment.id,
    });
    if (!availability.passed) {
      throw new BadRequestException(availability.reason);
    }

    if (assignment.projectBranch) {
      assignment.projectBranch.status = ProjectBranchStatus.SCHEDULED;
      assignment.projectBranch.scheduledDate = new Date(scheduledDate);
      assignment.projectBranch.updatedBy = userId;
    }
    assignment.scheduledDate = new Date(scheduledDate);
    assignment.updatedBy = userId;

    const saved = await this.dataSource.transaction(async (manager) => {
      if (assignment.projectBranch) {
        await manager.save(assignment.projectBranch);
      }
      if (assignment.assessment) {
        await manager.save(assignment.assessment);
      }
      return manager.save(assignment);
    });

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_SCHEDULED',
      entityType: 'ASSIGNMENT',
      entityId: saved.id,
      userId,
      remarks: remarks ?? `Scheduled audit for ${scheduledDate}.`,
    });

    this.publishAssignmentEvent('assignment:scheduled', saved, {
      previousState: saved.status,
      newState: saved.status,
      userId,
    });

    return saved;
  }

  private publishAssignmentEvent(eventType: string, assignment: AssignmentEntity, event: any) {
    this.eventPublisher.publish(eventType, {
      eventType,
      assignmentId: assignment.id,
      assignmentNumber: assignment.assignmentNumber,
      previousState: event.previousState || assignment.status,
      newState: assignment.status,
      assayerId: assignment.assayerId,
      organizationId: (assignment as any).projectBranch?.project?.organizationId,
      userId: event.userId,
      timestamp: event.timestamp || new Date(),
      metadata: event.metadata,
    });
  }

  async findAll(
    page = 1, limit = 50,
    status?: string,
    projectBranchStatus?: string,
    unscheduledOnly?: boolean,
    priority?: string,
    scope?: Partial<GlobalScope>,
  ): Promise<{ assignments: AssignmentEntity[]; total: number }> {
    const where: any = { isActive: true };
    if (status) {
      const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        where.status = statuses[0];
      } else if (statuses.length > 1) {
        where.status = In(statuses);
      }
    }
    if (projectBranchStatus) {
      const pbStatuses = projectBranchStatus.split(',').map((s) => s.trim()).filter(Boolean);
      if (pbStatuses.length === 1) {
        where.projectBranch = { status: pbStatuses[0] };
      } else if (pbStatuses.length > 1) {
        where.projectBranch = { status: In(pbStatuses) };
      }
    }
    if (priority) {
      const priorities = priority.split(',').map((s) => s.trim()).filter(Boolean);
      if (priorities.length === 1) {
        where.priority = priorities[0];
      } else if (priorities.length > 1) {
        where.priority = In(priorities);
      }
    }

    if (unscheduledOnly) {
      /**
       * "Has no calendar entry" as a predicate the database answers, not a list we carry.
       *
       * This used to SELECT every active schedule's assignment_id — the whole table, which
       * grows with every accepted job — ship it to Node, and send it back as `NOT IN (...)`.
       * TypeORM binds one parameter per element and Postgres refuses a Bind message with more
       * than 65,535 of them, so past 65k active schedules the filter did not merely get slow:
       * the endpoint failed outright. NOT EXISTS is the same question asked in one place, using
       * the schedules table's own index on assignment_id.
       */
      where.id = Raw(
        (alias: string) =>
          `NOT EXISTS (SELECT 1 FROM schedules s WHERE s.assignment_id = ${alias} AND s.is_active = true)`,
      );
    }

    // The global scope reaches an assignment through its branch: assignment → project_branch →
    // branch, where region/state/zone live. Merged into the existing `projectBranch` clause
    // rather than assigned over it, so a `projectBranchStatus` filter set above survives.
    const branchWhere = branchScopeWhere(scope);
    if (branchWhere) {
      where.projectBranch = { ...(where.projectBranch ?? {}), branch: branchWhere };
    }
    if (scope?.projectId) where.projectId = scope.projectId;

    /**
     * The page and its total, as two queries rather than `findAndCount`.
     *
     * `findAndCount` applies the SAME relation list to both halves, so counting the rows meant
     * `COUNT(DISTINCT id)` across six LEFT JOINs — measured at 75 ms of the 130 ms this endpoint
     * took on the 200k-row book, to produce a number none of those joins affect. The count only
     * needs whatever the filter itself joins (the scope reaches region through the branch), and
     * TypeORM builds exactly that from the same `where`. Run in parallel, so the page no longer
     * waits for the count either.
     */
    /**
     * Paginate on ids, then hydrate — because `find({ relations, take, skip })` does not do what
     * it looks like it does.
     *
     * TypeORM cannot apply LIMIT directly to a query with joined collections (one assignment can
     * match several joined rows, so LIMIT 25 would cut mid-entity). Its answer is to wrap the whole
     * thing in `SELECT DISTINCT … FROM (<the entire select>) "distinctAlias"` to find the page's
     * ids first. That inner select carries **every column of all six relations**. Measured on the
     * 200k book, the statement it emits is **28,179 characters** and runs at 67.7 ms mean — the
     * single most expensive repeatable query in the system, on the most-used screen in it — to
     * produce twenty-five uuids.
     *
     * Asking for the ids ourselves makes the intent explicit and the query small: no relations, so
     * no distinct wrapper, and only the joins the filter itself needs (TypeORM still derives those
     * from `where`, which is how a region-scoped filter continues to reach through the branch).
     * The page is then hydrated by id, where LIMIT is no longer involved and the joins are free to
     * fan out.
     *
     * `id: 'ASC'` matches the tiebreak TypeORM's own distinct wrapper appended (`ORDER BY
     * created_at DESC, id ASC`), and both queries below use it so the hydration cannot re-sort the
     * page — `In` does not preserve order.
     *
     * Applying it to the *returned* rows as well is the one behaviour change here, and it is
     * deliberate: the old hydration ordered by `created_at` alone, so rows sharing a timestamp came
     * back in whatever order the plan produced. Page *membership* was already stable and was
     * verified to be byte-identical before and after this change across pages 2, 7 and 40 — only
     * the order within a page differs. Worth having, not worth overstating: the development
     * database has 20 distinct timestamps for 20 rows, so ties are a fixture artefact today (the
     * 200k fixture generates 520 rows per timestamp) rather than something operators are hitting.
     */
    const [pageRows, total] = await Promise.all([
      this.assignmentRepository.find({
        where,
        /**
         * `createdAt` is selected even though only `id` is used, and it is not optional.
         *
         * Dropping `relations` does NOT remove TypeORM's `SELECT DISTINCT … "distinctAlias"`
         * wrapper — joins do, and a `where` that reaches through `projectBranch` (the
         * `projectBranchStatus`, `unscheduledOnly` and region-scope filters all do) still joins.
         * The wrapper projects exactly what `select` lists, then orders the outer query by the
         * sort columns, so ordering by a column that is not selected fails at the database with
         * `column distinctAlias.AssignmentEntity_created_at does not exist`.
         *
         * This shipped broken: the first version selected `id` alone and was measured only on the
         * unfiltered list, which has no joins and therefore no wrapper. Every filtered view 500'd.
         * `filtered pagination` in the spec now covers those paths.
         */
        select: { id: true, createdAt: true },
        order: { createdAt: 'DESC', id: 'ASC' },
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.assignmentRepository.count({ where }),
    ]);

    const assignments = pageRows.length
      ? await this.assignmentRepository.find({
          where: { id: In(pageRows.map((r) => r.id)) },
          relations: ['projectBranch', 'projectBranch.branch', 'assessment', 'assessment.branch', 'assayer', 'project'],
          order: { createdAt: 'DESC', id: 'ASC' },
        })
      : [];

    return { assignments, total };
  }

  /**
   * The field app's work list.
   *
   * ## Why this takes a scope
   *
   * It used to return every assignment the assayer had ever been given, in every status, with
   * no limit — and the phone fetches it twice on a cold start, on each of twelve socket events,
   * every five minutes, and after every mutation. At 6.4 KB a row that is roughly 3 MB per
   * fetch for someone with 500 jobs behind them, over a rural link, to render a screen that
   * shows the next few.
   *
   * `active` is what the app needs to operate: everything still in flight, plus recently
   * settled work, because the earnings screen totals recent completions and the schedule shows
   * a short history. `history` pages the rest, newest first, on a keyset cursor.
   *
   * Omitting `scope` keeps the old everything-at-once behaviour, bounded by a cap, so a handset
   * still running the previous bundle is not broken by a server deploy. Once the fleet has the
   * update the default can become `active`.
   */
  async findByAssayer(
    assayerId: string,
    options: { scope?: 'active' | 'history' | 'all'; limit?: number; before?: string } = {},
  ): Promise<{ assignments: AssignmentEntity[]; hasMore: boolean; nextCursor: string | null }> {
    const scope = options.scope ?? 'all';
    const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_ASSAYER_PAGE_SIZE, 1), MAX_ASSAYER_PAGE_SIZE);

    const IN_FLIGHT = [
      AssignmentStatus.PENDING,
      AssignmentStatus.ACCEPTED,
      AssignmentStatus.CHECKED_IN,
      AssignmentStatus.IN_PROGRESS,
    ];
    const TERMINAL = [AssignmentStatus.COMPLETED, AssignmentStatus.REJECTED, AssignmentStatus.CANCELLED];

    const query = this.assignmentRepository
      .createQueryBuilder('a')
      .where('a.assayerId = :assayerId', { assayerId })
      .andWhere('a.isActive = true');

    if (scope === 'active') {
      // In flight, plus anything settled inside the recency window — the earnings screen totals
      // recent completions and the schedule shows a short history, so "open only" would empty
      // both. Anything older is `history`.
      const since = new Date(Date.now() - RECENT_TERMINAL_DAYS * 24 * 60 * 60 * 1000);
      query.andWhere(
        '(a.status IN (:...inFlight) OR (a.status IN (:...terminal) AND a.updatedAt >= :since))',
        { inFlight: IN_FLIGHT, terminal: TERMINAL, since },
      );
    } else if (scope === 'history') {
      query.andWhere('a.status IN (:...terminal)', { terminal: TERMINAL });
    } else {
      query.andWhere('a.status IN (:...all)', { all: [...IN_FLIGHT, ...TERMINAL] });
    }

    // Keyset pagination on the same key the list is ordered by. `createdAt` alone is not unique,
    // so the id breaks ties — without it a page boundary that lands inside a group of rows
    // created in the same millisecond either repeats or skips one.
    if (options.before) {
      const [cursorDate, cursorId] = decodeAssayerCursor(options.before);
      if (cursorDate) {
        query.andWhere('(a.createdAt, a.id) < (:cursorDate, :cursorId)', { cursorDate, cursorId });
      }
    }

    const rows = await query
      .orderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC')
      // One more than asked for, so "is there another page" needs no COUNT over the book.
      .take(limit + 1)
      .getMany();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    if (scope === 'all' && hasMore) {
      AssignmentService.logger.warn(
        `Assayer ${assayerId} has more than ${limit} assignments; the compatibility (unscoped) list is truncated. ` +
          `The field app should request scope=active and page history separately.`,
      );
    }

    const assignments = page.length
      ? await this.assignmentRepository.find({
          where: { id: In(page.map((r) => r.id)) },
      // `expenses` feeds the mobile earnings screen's claim total, which had no data source.
      relations: {
        projectBranch: { branch: true },
        assayer: true,
        project: true,
        expenses: true,
      },
      /**
       * The assayer relation is trimmed to the two columns the caller actually reads.
       *
       * This is one assayer's own work list, so the full `assayer` row was being serialised
       * onto every assignment in it — the same ~2 KB record repeated. Measured on this account:
       * 16 rows, 103 KB, of which roughly a third was that duplication. Nothing in this method
       * touches the relation; the mobile client reads `latitude` and `longitude` from it and
       * nothing else, to compute the distance shown on the card. On the rural data an assayer
       * actually works over, that third is seconds.
       *
       * Selecting rather than dropping: the relation still has to be loaded for the distance,
       * and the identity/banking columns it used to carry have no business crossing the wire.
       */
      select: {
        assayer: { id: true, latitude: true, longitude: true },
      },
      order: { createdAt: 'DESC' },
        })
      : [];

    const nextCursor = hasMore && page.length ? encodeAssayerCursor(page[page.length - 1]) : null;

    const projectIds = [...new Set(assignments.map((a) => a.projectBranch!.projectId))];
    const versionRepo = this.dataSource.getRepository(CustomerMasterVersionEntity);
    const recordRepo = this.dataSource.getRepository(CustomerRecordEntity);

    // One query for every project on the list, not one per project. Ordered ascending so the
    // last row written per project below is the highest version — the same row the per-project
    // `findOne(... 'DESC')` returned.
    const projectVersions = new Map<string, CustomerMasterVersionEntity | null>();
    if (projectIds.length) {
      const versions = await versionRepo.find({
        where: { projectId: In(projectIds), status: CustomerMasterStatus.APPROVED, isActive: true },
        order: { versionNumber: 'ASC' },
      });
      for (const version of versions) projectVersions.set(version.projectId, version);
    }

    // The assayer's current going rate, resolved by the same calculator that prices the work.
    // This used to be a bare findOne with no date window and no ordering — an arbitrary profile
    // row won — falling back to a hardcoded 1200 that ignored the client's contracted rate.
    // The result is shown to the field worker on their phone as their own standard base fee,
    // so it must be the figure the platform would actually pay.
    const { baseFee: baseFeeAmount } = await this.feePolicyService.resolveBaseFee(
      assayerId,
      await this.feePolicyService.getRates(null),
      new Date(),
    );

    const queryRepo = this.dataSource.getRepository(ValidationQueryEntity);
    const caseRepo = this.dataSource.getRepository(ValidationCaseEntity);

    /**
     * Customer counts, validation cases and their queries — three queries for the whole list
     * rather than three per assignment.
     *
     * The customer ROWS are deliberately not sent any more. Every record for the branch was
     * being serialised onto each assignment, `raw_data` jsonb and all — the client's entire
     * spreadsheet row per customer — so a phone held bank customers' account numbers and
     * pledged weights for jobs finished months ago, in a plaintext cache file. Nothing in the
     * app ever rendered them: one screen reads the count, and the count is what is sent.
     */
    const branchKeys = assignments
      .map((a) => ({
        versionId: projectVersions.get(a.projectBranch!.projectId)?.id,
        branchId: a.projectBranch!.branchId,
      }))
      .filter((k): k is { versionId: string; branchId: string } => Boolean(k.versionId));

    const customerCounts = new Map<string, number>();
    if (branchKeys.length) {
      const counts = await recordRepo
        .createQueryBuilder('r')
        .select('r.customerMasterVersionId', 'versionId')
        .addSelect('r.branchId', 'branchId')
        .addSelect('COUNT(*)::int', 'count')
        .where('r.isActive = true')
        .andWhere('r.customerMasterVersionId IN (:...versionIds)', {
          versionIds: [...new Set(branchKeys.map((k) => k.versionId))],
        })
        .andWhere('r.branchId IN (:...branchIds)', {
          branchIds: [...new Set(branchKeys.map((k) => k.branchId))],
        })
        .groupBy('r.customerMasterVersionId')
        .addGroupBy('r.branchId')
        .getRawMany();
      for (const row of counts) customerCounts.set(`${row.versionId}:${row.branchId}`, Number(row.count) || 0);
    }

    const projectBranchIds = assignments.map((a) => a.projectBranchId).filter(Boolean) as string[];
    const casesByProjectBranch = new Map<string, string[]>();
    const queriesByCase = new Map<string, ValidationQueryEntity[]>();
    if (projectBranchIds.length) {
      const cases = await caseRepo.find({
        where: { projectBranchId: In([...new Set(projectBranchIds)]), isActive: true },
      });
      for (const c of cases) {
        const list = casesByProjectBranch.get(c.projectBranchId) ?? [];
        list.push(c.id);
        casesByProjectBranch.set(c.projectBranchId, list);
      }
      const caseIds = cases.map((c) => c.id);
      if (caseIds.length) {
        const queries = await queryRepo.find({
          where: { validationCaseId: In(caseIds), isActive: true },
          order: { createdAt: 'DESC' },
        });
        for (const q of queries) {
          const list = queriesByCase.get(q.validationCaseId) ?? [];
          list.push(q);
          queriesByCase.set(q.validationCaseId, list);
        }
      }
    }

    /**
     * Whether the branch's audit packet has actually been dispatched.
     *
     * Sent with the assignment so the field app can *gate* the download affordance instead of
     * offering it unconditionally and reporting "not available yet" only after the assayer
     * taps it. Batched into one query — this is the app's main list.
     */
    const readiness = await this.documentService.readinessForBranches(
      assignments.map((a) => a.projectBranchId).filter(Boolean) as string[],
    );

    for (const assignment of assignments) {
      (assignment as any).documentReadiness =
        readiness[assignment.projectBranchId as string] ??
        { state: 'NONE', dispatchedCount: 0, message: 'No audit paperwork has been prepared for this branch yet.' };

      // Named distinctly from proposedFee/agreedFee (the actual negotiated total for this
      // assignment, immutable once set) — this is only the assayer's CURRENT going rate,
      // for reference, and must never be conflated with what was actually agreed historically.
      (assignment as any).currentStandardBaseFee = baseFeeAmount;
      const version = projectVersions.get(assignment.projectBranch!.projectId);
      const counted = version
        ? customerCounts.get(`${version.id}:${assignment.projectBranch!.branchId}`) ?? 0
        : 0;
      (assignment as any).customerCount = counted > 0 ? counted : assignment.projectBranch?.packetCount || 15;

      const caseIds = assignment.projectBranchId
        ? casesByProjectBranch.get(assignment.projectBranchId) ?? []
        : [];
      (assignment as any).queries = caseIds.flatMap((id) => queriesByCase.get(id) ?? []);
    }

    return { assignments, hasMore, nextCursor };
  }

  /**
   * Comments are the operational narrative on an assignment — why a date moved, what a branch
   * manager said. They were stored but never audited, so a comment could be added and the
   * comment row later removed with nothing showing it had existed.
   */
  async addComment(assignmentId: string, comment: string, userId: string, userName: string): Promise<AssignmentCommentEntity> {
    const assignment = await this.findOne(assignmentId);
    const commentRecord = this.dataSource.getRepository(AssignmentCommentEntity).create({
      assignmentId: assignment.id,
      userId,
      userName,
      comment,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.dataSource.getRepository(AssignmentCommentEntity).save(commentRecord);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_COMMENT_ADDED',
      entityType: 'ASSIGNMENT',
      entityId: assignmentId,
      userId,
      remarks: comment.length > 200 ? `${comment.slice(0, 200)}…` : comment,
      metadata: { commentId: saved.id, authorName: userName },
    });

    try {
      this.eventPublisher.publish('comment:added', {
        eventType: 'comment:added',
        assignmentId: assignment.id,
        commentId: saved.id,
        userId,
        userName,
        comment,
      });
    } catch (err) {
      console.error('Failed to publish comment:added event:', err);
    }

    return saved;
  }

  async getTimeline(assignmentId: string): Promise<any[]> {
    const assignment = await this.findOne(assignmentId);
    
    // Fetch audit history
    const { events } = await this.auditService.getEntityHistory('ASSIGNMENT', assignment.id, 100);
    
    // Fetch comments
    const comments = await this.dataSource.getRepository(AssignmentCommentEntity).find({
      where: { assignmentId: assignment.id, isActive: true },
      order: { createdAt: 'ASC' },
    });

    const timelineEvents: any[] = [];

    for (const e of events) {
      timelineEvents.push({
        id: e.id,
        type: 'SYSTEM_EVENT',
        title: e.eventType,
        description: e.remarks,
        timestamp: e.occurredAt,
        user: e.userDisplayName || e.userId,
      });
    }

    for (const c of comments) {
      timelineEvents.push({
        id: c.id,
        type: 'COMMENT',
        title: `Comment by ${c.userName}`,
        description: c.comment,
        timestamp: c.createdAt,
        user: c.userName,
      });
    }

    // Sort chronologically (most recent first)
    return timelineEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  async checkSlaBreaches(): Promise<number> {
    const now = new Date();

    // The overdue filter runs in SQL, not in JavaScript over the whole book.
    //
    // This used to load every active COMPLIANT PENDING/ACCEPTED assignment and test slaDueDate in
    // the loop. On a realistic book that is tens of thousands of rows shipped and hydrated into
    // entity instances every 15 minutes, to flag the handful actually past due (measured on the
    // 200k-assignment scale DB: 57,143 rows loaded to touch 1,189). `slaDueDate < now` in the
    // WHERE clause returns only the rows that breach, so the scan's memory and CPU cost track the
    // breach rate, not the size of the whole open-offer pool.
    //
    // The branch relation is loaded here too: it is needed for the notification, and now that the
    // query returns only breaching rows the join is cheap — replacing the per-row findOne this
    // used to issue (one extra query per breach).
    const overdueAssignments = await this.assignmentRepository.find({
      where: {
        slaStatus: 'COMPLIANT',
        status: In([
          AssignmentStatus.PENDING,
          AssignmentStatus.ACCEPTED,
        ]),
        isActive: true,
        slaDueDate: LessThan(now),
      },
      relations: ['projectBranch', 'projectBranch.branch'],
    });

    let breachedCount = 0;
    for (const assignment of overdueAssignments) {
      assignment.slaStatus = 'BREACHED';
      await this.assignmentRepository.save(assignment);

      await this.auditService.recordEvent({
        category: EventCategory.SYSTEM,
        eventType: 'ASSIGNMENT_SLA_BREACHED',
        entityType: 'ASSIGNMENT',
        entityId: assignment.id,
        remarks: `SLA breach detected: Assignment ${assignment.assignmentNumber} exceeded response time deadline of ${assignment.slaDueDate}.`,
      });

      // Only rows still COMPLIANT reach this loop (see the query) and they are saved as BREACHED
      // first, so a row is notified on the flip and never again on later scans; the per-assignment
      // dedupe key is the second guard if a scan is retried mid-run.
      this.notificationDispatch.emitSafe({
        type: 'ASSIGNMENT_SLA_BREACHED',
        entityType: 'ASSIGNMENT',
        entityId: assignment.id,
        assayerId: assignment.assayerId,
        ownerUserId: assignment.createdBy ?? null,
        dedupeKey: `ASSIGNMENT_SLA_BREACHED:${assignment.id}`,
        payload: {
          assignmentId: assignment.id,
          assignmentNumber: assignment.assignmentNumber,
          branchName: assignment.projectBranch?.branch?.name ?? assignment.assignmentNumber,
          // No slaType column exists; the status the clock ran out in is what distinguishes
          // an unanswered offer from an accepted job that never got done.
          slaType: assignment.status === AssignmentStatus.PENDING ? 'response' : 'completion',
        },
      });

      breachedCount++;
    }

    return breachedCount;
  }

  /**
   * Auto-declines assignment offers still PENDING past their slaDueDate (response
   * deadline), so a non-responsive assayer never blocks a branch indefinitely.
   * Reuses rejectOffer() so the branch reverts to CANDIDATE_SEARCH, the original
   * assigning ops user is notified, and a realtime status-changed event fires —
   * identical to a manual rejection, just system-initiated.
   */
  async autoDeclineExpiredOffers(): Promise<number> {
    const now = new Date();

    // Past-due is filtered in SQL (the idx_assignments_open_offers partial index is shaped for
    // exactly this predicate), not by loading every active PENDING offer and testing the date in
    // the loop — 28,571 rows loaded to act on 555 on the scale DB. The branch relation rides the
    // same query, since the result set is now the handful being declined rather than the whole
    // pending pool; this replaces the per-row findOne the notification used to make.
    const pendingOffers = await this.assignmentRepository.find({
      where: {
        status: AssignmentStatus.PENDING,
        isActive: true,
        slaDueDate: LessThan(now),
      },
      relations: ['projectBranch', 'projectBranch.branch'],
    });

    // Channel-aware: PHONE-channel assayers may never see an in-app offer, so "no in-app answer
    // in 24h" is not a decline — it is the desk's call task still in progress. Auto-declining
    // them killed offers mid-negotiation. Their offers only leave PENDING by a human recording
    // the call outcome in the Operations Inbox. Resolved only for the overdue set, not the pool.
    const channels = await this.operationsInbox.resolveChannels(
      [...new Set(pendingOffers.map((a) => a.assayerId))],
    );

    let declinedCount = 0;
    for (const assignment of pendingOffers) {
      if (channels.get(assignment.assayerId) === 'PHONE') continue;
      // Backstop for the SQL predicate: a decline is irreversible, so a stray row (a mock, a
      // clock skew) must never be declined early. Real DB rows already satisfy this.
      if (!assignment.slaDueDate || assignment.slaDueDate >= now) continue;
      try {
        await this.rejectOffer(assignment.id, 'SYSTEM', 'AUTO_DECLINED_SLA_EXPIRED');
        declinedCount++;

        // Reusing rejectOffer means ops was told the assayer *declined* — the same message
        // a real refusal produces. Operationally those are different situations: a decline
        // is an answer, a timeout means nobody responded at all and the assayer may not even
        // know they were offered the work. `ASSIGNMENT_AUTO_DECLINED` exists in the catalogue
        // for exactly this and had no code path able to emit it.
        this.notificationDispatch.emitSafe({
          type: 'ASSIGNMENT_AUTO_DECLINED',
          entityType: 'ASSIGNMENT',
          entityId: assignment.id,
          assayerId: assignment.assayerId,
          ownerUserId: assignment.createdBy ?? null,
          dedupeKey: `ASSIGNMENT_AUTO_DECLINED:${assignment.id}`,
          payload: {
            assignmentId: assignment.id,
            assignmentNumber: assignment.assignmentNumber,
            branchName: assignment.projectBranch?.branch?.name ?? 'A branch',
          },
        });
      } catch (err) {
        console.error(`Failed to auto-decline expired assignment ${assignment.id}:`, err);
      }
    }

    return declinedCount;
  }

  /**
   * What the movement trail says about the journey this assignment was paid travel for.
   *
   * Assembled here rather than in LocationTrailService because the *claimed* side of the comparison
   * lives in this module. Offers now record the distance their quote priced
   * (`quotedDistanceKm`, written at creation), and that recorded figure is preferred: it is
   * what the money was actually based on. Older assignments predate the column, so the
   * distance is recomputed from home to branch the way the quote would have — and
   * `expectedIsRecomputed` says so plainly, because the assayer's registered home may have
   * changed since and a reviewer deserves to know the baseline was reconstructed rather than
   * recorded.
   */
  async getTravelVerification(assignmentId: string): Promise<{
    assignmentId: string;
    assignmentNumber: string;
    checkedInAt: Date | null;
    trackingEnabled: boolean;
    expectedDistanceKm: number | null;
    /**
     * How `expectedDistanceKm` was measured — `OSRM` by road, `ESTIMATE` as a straight line.
     * The trail measures the road actually driven, so a journey compared against a straight-line
     * quote will read long by 11–56 % through no fault of the assayer; a reviewer must be able
     * to see that the baseline, not the claim, is the approximate one. Null when unrecorded
     * (offers made before the column existed) and no recomputation was possible.
     */
    expectedDistanceSource: 'OSRM' | 'ESTIMATE' | null;
    expectedIsRecomputed: boolean;
    assessment: Awaited<ReturnType<LocationTrailService['assessAssignmentTravel']>>;
    /** Why no assessment could be produced, when that is the case. */
    unavailableReason: string | null;
  }> {
    const assignment = await this.findOne(assignmentId);
    const assayer = assignment.assayer;
    const branch = assignment.projectBranch?.branch;

    const base = {
      assignmentId: assignment.id,
      assignmentNumber: assignment.assignmentNumber,
      checkedInAt: assignment.checkedInAt ?? null,
      trackingEnabled: Boolean(assayer?.isLiveEnabled),
      expectedDistanceKm: null as number | null,
      expectedDistanceSource: null as 'OSRM' | 'ESTIMATE' | null,
      expectedIsRecomputed: true,
      assessment: null,
      unavailableReason: null as string | null,
    };

    if (!assignment.checkedInAt) {
      return {
        ...base,
        unavailableReason:
          'This assignment has no check-in, so there is no confirmed arrival to measure a journey against.',
      };
    }

    // The quote's basis. Preferred: the distance recorded when the offer was priced — the
    // number the money was actually based on. Fallback for pre-column assignments: recompute
    // home to branch, routed where possible, straight-line otherwise — the same order of
    // preference the fee calculation itself uses.
    let expectedDistanceKm: number | null =
      assignment.quotedDistanceKm != null ? Number(assignment.quotedDistanceKm) : null;
    // The label recorded with the quote. Null for offers older than the column — their figure
    // was in fact always a straight line, but the row does not say so and this does not guess.
    let expectedDistanceSource: 'OSRM' | 'ESTIMATE' | null =
      expectedDistanceKm != null ? (assignment.quotedDistanceSource ?? null) : null;
    let expectedIsRecomputed = expectedDistanceKm == null;

    if (expectedDistanceKm == null &&
        branch?.latitude != null && branch?.longitude != null &&
        assayer?.homeLatitude != null && assayer?.homeLongitude != null) {
      try {
        const route = await this.routingService.calculateRoute(
          { latitude: Number(branch.latitude), longitude: Number(branch.longitude) },
          { latitude: Number(assayer.homeLatitude), longitude: Number(assayer.homeLongitude) },
        );
        expectedDistanceKm = route?.distanceKm ?? null;
        expectedDistanceSource = expectedDistanceKm != null ? (route?.source ?? 'ESTIMATE') : null;
      } catch {
        expectedDistanceKm = calculateHaversineDistance(
          Number(branch.latitude), Number(branch.longitude),
          Number(assayer.homeLatitude), Number(assayer.homeLongitude),
        );
        expectedDistanceSource = 'ESTIMATE';
      }
    }

    const assessment = await this.locationTrail.assessAssignmentTravel({
      assayerId: assignment.assayerId,
      checkedInAt: assignment.checkedInAt,
      expectedDistanceKm,
      trackingEnabled: Boolean(assayer?.isLiveEnabled),
    });

    return { ...base, expectedDistanceKm, expectedDistanceSource, expectedIsRecomputed, assessment, unavailableReason: null };
  }

  /**
   * How long a KPI tile may be stale, and why an index was measured and then not added.
   *
   * The rollup reads every active assignment to produce about nine numbers: 200,000 rows in,
   * `(statuses × SLA states)` out. Measured on the 200k book it is **~50 ms**, consistently, and
   * it runs on a screen every operator opens — so twenty operators refreshing costs a second of
   * database CPU between them, for one answer they would all have accepted sharing.
   *
   * **An index does not fix this, which is worth recording so nobody re-tries it.** A partial
   * index on `(status, sla_status) WHERE is_active` turns the parallel sequential scan into a
   * parallel Index Only Scan and cuts buffers from **4,913 to 175** — a 28x reduction that buys
   * almost nothing: 49 ms becomes 47 ms. The cost was never I/O. Aggregating 200,000 rows is
   * 200,000 rows of CPU whether they arrive from the heap or from an index, and the write cost of
   * another index on the hottest table in the system is real. (Note the index cannot be used at
   * all while the aggregate is `COUNT(assignment.id)` — that needs a column the index lacks.
   * `COUNT(*)` is exactly equivalent here, `id` being a NOT NULL primary key, and was verified to
   * produce identical counts on the fixture. It is left as-is because without the index it changes
   * nothing.)
   *
   * So the lever is not making the scan cheaper, it is doing it once for everybody. Ten seconds is
   * short enough that a tile never visibly disagrees with the list under it — an operator who
   * completes an assignment and looks up sees the new number within one breath — and long enough
   * that a desk full of people refreshing costs one scan rather than twenty. It matches what the
   * operations dashboard, the command centre and the HR overview already do.
   *
   * When the book reaches a size where 50 ms becomes 500 ms, the answer is a rollup maintained on
   * write, not a bigger index. The measurement above is why.
   */
  private static readonly DASHBOARD_SUMMARY_TTL_S = 10;

  async getDashboardSummary(scope?: Partial<GlobalScope>): Promise<any> {
    // These KPI tiles sit above the assignment list. Leaving them unscoped while the list below
    // is scoped is worse than not scoping either: the operator reads "42 in progress", counts 6
    // rows, and has no way to tell which number is lying.
    //
    // Every scope dimension is therefore in the cache key too. A key that ignored region would
    // serve one desk's tiles to the next desk that loaded the page inside the TTL — the same trap
    // the command centre's key comment describes, and it is worse here, because a wrong count
    // looks exactly like a right one.
    // Every field of GlobalScope, not just the ones this method reads directly — `applyBranchScope`
    // filters on zone and state as well, and a key that tracked only what is visible in this
    // function would go stale the moment that helper learns a new dimension.
    const cacheKey = [
      'assignments:dashboard-summary',
      scope?.projectId ?? 'all',
      scope?.clientId ?? 'all',
      scope?.zoneId ?? 'all',
      scope?.state ?? 'all',
      // Sorted, because two accounts holding the same regions in a different order must share a
      // cache entry rather than each paying for their own.
      scope?.regions?.slice().sort().join('+') ?? 'all',
    ].join(':');

    return this.cache.wrap(cacheKey, AssignmentService.DASHBOARD_SUMMARY_TTL_S, () =>
      this.computeDashboardSummary(scope),
    );
  }

  private async computeDashboardSummary(scope?: Partial<GlobalScope>): Promise<any> {
    /**
     * Four breakdowns from one pass over the table.
     *
     * These were two `getRawMany()` calls awaited one after the other — the same rows, the same
     * filters and the same joins, read twice, sequentially, to group by two different columns.
     * Over a 200,000-row assignment book that was ~29 ms of full scan each, and it grows linearly
     * with the history: the tiles sit above the assignment list on a screen every operator opens.
     *
     * `branchStatus` and `priority` joined the same pass for the same reason `Assignments.tsx`'s
     * KPI row used to fire: the desk's "Active"/"Closed" tiles filter by the *branch's* status
     * and "Escalated" filters by assignment priority — neither derivable from `statusCounts`
     * alone — so the frontend was re-deriving them with 6 separate `?page=1&limit=1` full-table
     * COUNT queries against the paginated list endpoint on every load and scope change, on top of
     * this endpoint it never called. One grouped scan answers all four.
     *
     * Grouping by all four columns at once is still one scan. The result is a cross-tab of at
     * most (statuses × SLA states × branch states × priorities) rows — a few hundred at the
     * outside, since only combinations that actually occur produce a row — which folds into the
     * four totals below in memory. Nothing about the individual numbers changes.
     */
    const qb = this.assignmentRepository
      .createQueryBuilder('assignment')
      .select('assignment.status', 'status')
      .addSelect('assignment.slaStatus', 'slaStatus')
      .addSelect('assignment.priority', 'priority')
      .addSelect('spb.status', 'branchStatus')
      .addSelect('COUNT(assignment.id)', 'count')
      .where('assignment.isActive = :isActive', { isActive: true })
      .groupBy('assignment.status')
      .addGroupBy('assignment.slaStatus')
      .addGroupBy('assignment.priority')
      .addGroupBy('spb.status')
      // left, not inner: an assignment with no project branch (projectBranchId is nullable)
      // must still be counted in status/SLA/priority — it simply contributes a null branchStatus.
      .leftJoin('assignment.projectBranch', 'spb');

    if (needsBranchJoin(scope)) {
      qb.innerJoin('spb.branch', 'sbranch');
      applyBranchScope(qb, scope, { branch: 'sbranch', project: 'spb' });
    }
    if (scope?.projectId) {
      qb.andWhere('assignment.project_id = :scopeProjectId', { scopeProjectId: scope.projectId });
    }

    const rows = await qb.getRawMany();

    const summary: Record<string, number> = {};
    const slaSummary: Record<string, number> = {};
    const prioritySummary: Record<string, number> = {};
    const branchStatusSummary: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const n = Number(row.count);
      total += n;
      // A null SLA status, priority or branch status is still an assignment; it just contributes
      // to the status total only.
      if (row.status != null) summary[row.status] = (summary[row.status] ?? 0) + n;
      if (row.slaStatus != null) slaSummary[row.slaStatus] = (slaSummary[row.slaStatus] ?? 0) + n;
      if (row.priority != null) prioritySummary[row.priority] = (prioritySummary[row.priority] ?? 0) + n;
      if (row.branchStatus != null) branchStatusSummary[row.branchStatus] = (branchStatusSummary[row.branchStatus] ?? 0) + n;
    }

    return {
      total,
      statusCounts: summary,
      slaCounts: slaSummary,
      priorityCounts: prioritySummary,
      branchStatusCounts: branchStatusSummary,
    };
  }

  /**
   * The "Falling behind" board: every assignment that has slipped past a deadline or its audit
   * date, ranked most-overdue-first. The SLA machinery already flags these (`slaStatus`,
   * `slaDueDate`, the 15-minute scanner) — but nothing rendered them, so a breach only ever
   * became visible if someone happened to open the right assignment. This is the screen.
   *
   * "Behind" is three things at once, which is why the ranking is done in memory rather than by a
   * single ORDER BY:
   *   1. `slaStatus = BREACHED`      — the scanner has already flagged it.
   *   2. `slaDueDate < now`          — the response/completion clock has run out but the scanner
   *                                    (which runs every 15 min) has not flipped it yet.
   *   3. an ACCEPTED audit whose `scheduledDate` has passed with no check-in — the visit date came
   *      and went and nobody attended.
   *
   * The set is only the breached/overdue tail of the book, not the whole thing, so this stays
   * cheap even on a large book; it is capped and ranked defensively all the same.
   */
  async getFallingBehind(scope?: Partial<GlobalScope>): Promise<FallingBehindItem[]> {
    const now = new Date();
    const todayKey = businessTodayDateKey();

    const qb = this.assignmentRepository
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.assayer', 'assayer')
      .leftJoinAndSelect('a.projectBranch', 'pb')
      .leftJoinAndSelect('pb.branch', 'branch')
      .leftJoinAndSelect('a.project', 'project')
      .leftJoinAndSelect('project.client', 'client')
      .where('a.isActive = true')
      .andWhere('a.status IN (:...statuses)', {
        statuses: [
          AssignmentStatus.PENDING,
          AssignmentStatus.ACCEPTED,
          AssignmentStatus.CHECKED_IN,
          AssignmentStatus.IN_PROGRESS,
        ],
      })
      .andWhere(
        `(
           a.sla_status = 'BREACHED'
           OR (a.sla_due_date IS NOT NULL AND a.sla_due_date < :now)
           OR (a.status = :accepted AND a.checked_in_at IS NULL AND a.scheduled_date IS NOT NULL AND a.scheduled_date < :today)
         )`,
        { now, today: todayKey, accepted: AssignmentStatus.ACCEPTED },
      );

    // Same region/zone/state scoping every assignment read follows: a West coordinator must not
    // be handed the South's overdue work. The branch relation is already joined as `branch`, so
    // this adds predicates, not joins — mirrors the operations-inbox replacement lane.
    applyBranchScope(qb, scope, { branch: 'branch', project: 'pb' });
    if (scope?.projectId) {
      qb.andWhere('a.project_id = :scopeProjectId', { scopeProjectId: scope.projectId });
    }

    /**
     * Soonest deadline first, and by entity property — not by column name.
     *
     * `take()` on a query with joined relations makes TypeORM fetch distinct ids in a subquery
     * and re-apply the ordering to it, which means every ORDER BY term is looked up in the
     * entity metadata. `a.sla_due_date` is the database column, not a property path, so the
     * lookup returned nothing and the whole endpoint threw
     * `Cannot read properties of undefined (reading 'databaseName')` — a 500 on every request
     * to the Falling Behind board. The WHERE clauses above can keep using column names because
     * those are passed through to SQL untouched; ordering cannot.
     *
     * NULLS LAST is Postgres's default for ASC and is stated rather than assumed, because it
     * decides which rows survive the cap: an assignment that is overdue only by its audit date
     * carries no SLA deadline, so it sorts last and is the first to be cut. `id` breaks ties so
     * the 500 are a stable set rather than reshuffling between requests.
     */
    const rows = await qb
      .orderBy('a.slaDueDate', 'ASC', 'NULLS LAST')
      .addOrderBy('a.scheduledDate', 'ASC', 'NULLS LAST')
      .addOrderBy('a.id', 'ASC')
      .take(500)
      .getMany();
    const todayMs = new Date(`${todayKey}T00:00:00`).getTime();

    const items: FallingBehindItem[] = rows.map((a) => {
      // `businessDateKey`, not `String(...).slice(0, 10)`: the driver hands `scheduledDate` back
      // as a string for a `date` column but as a Date once anything hydrates it as an entity,
      // and `String(aDate).slice(0, 10)` is "Sat Aug 31" — which compares greater than every
      // ISO key, so the overdue test below silently never fired.
      const dateKey = a.scheduledDate ? businessDateKey(a.scheduledDate as any) : null;
      const dueMs = a.slaDueDate ? now.getTime() - new Date(a.slaDueDate).getTime() : 0;
      const dueDays = dueMs > 0 ? Math.floor(dueMs / 86_400_000) : 0;
      const schedOverdue =
        a.status === AssignmentStatus.ACCEPTED && !a.checkedInAt && dateKey != null && dateKey < todayKey;
      const schedDays = schedOverdue
        ? Math.max(0, Math.floor((todayMs - new Date(`${dateKey}T00:00:00`).getTime()) / 86_400_000))
        : 0;
      const daysOverdue = Math.max(dueDays, schedDays);

      let slaState: string;
      let nextAction: FallingBehindItem['nextAction'];
      if (a.status === AssignmentStatus.PENDING) {
        slaState = 'Offer still unanswered past its deadline';
        nextAction = 'REASSIGN';
      } else if (schedOverdue) {
        slaState = 'Audit date has passed with no check-in';
        nextAction = 'RESCHEDULE';
      } else {
        slaState = 'Past its completion deadline';
        nextAction = 'OPEN';
      }

      const client = (a as any).project?.client;
      return {
        id: a.id,
        assignmentNumber: a.assignmentNumber,
        status: a.status,
        projectId: a.projectId ?? null,
        projectBranchId: a.projectBranchId ?? null,
        branchId: a.projectBranch?.branch?.id ?? null,
        branchName: a.projectBranch?.branch?.name ?? null,
        branchCity: a.projectBranch?.branch?.city ?? null,
        projectName: (a as any).project?.name ?? null,
        clientName: client?.displayName ?? client?.name ?? null,
        assayerId: a.assayerId ?? null,
        assayerName: a.assayer?.displayName ?? null,
        scheduledDate: dateKey,
        slaDueDate: a.slaDueDate ? new Date(a.slaDueDate).toISOString() : null,
        daysOverdue,
        slaState,
        nextAction,
      };
    });

    // Most overdue first; the board never re-sorts, so what a coordinator sees at the top is the
    // thing that has been waiting longest.
    items.sort((x, y) => y.daysOverdue - x.daysOverdue);
    return items;
  }

  async recordCheckIn(
    id: string,
    lat: number,
    lng: number,
    syncToken?: string,
    userId?: string,
    accuracyMeters?: number,
  ): Promise<{ success: boolean; assignment: AssignmentEntity; error?: string; message?: string }> {
    const assignment = await this.findOne(id);
    if (!assignment) {
      return { success: false, assignment: null as any, error: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found.' };
    }

    /**
     * Only the assigned assayer may check in, and only from a state that means they were
     * actually expected on site.
     *
     * Neither rule existed. Any authenticated assayer could check in on ANY assignment by id,
     * and could do so directly from PENDING or REJECTED — recording attendance at a branch
     * they had never accepted, skipping the acceptance step entirely. Both produce a
     * falsified attendance record in what is meant to be bank audit evidence.
     *
     * Staff roles are allowed through so ops can correct a record on the assayer's behalf;
     * `updatedBy` preserves who actually performed it.
     */
    const actorIsAssignedAssayer = !!userId && userId === assignment.assayerId;
    // Staff status is decided once and reused: it gates both "whose assignment is this" and
    // the schedule/geofence guards below — ops correcting a record must not be blocked by
    // rules that exist to keep the assayer's own attendance honest.
    let staffOverride = false;
    if (!actorIsAssignedAssayer) {
      const actor = await this.dataSource
        .getRepository(UserEntity)
        .findOne({ where: { id: userId }, relations: ['roles'] })
        .catch(() => null);
      const actorRoles: string[] = (actor?.roles ?? []).map((r: any) => r?.name).filter(Boolean);
      staffOverride = actorRoles.some((r) =>
        [
          SystemRole.ADMIN,
          SystemRole.OPERATIONS,
        ].includes(r as SystemRole),
      );
      if (!staffOverride) {
        return {
          success: false,
          assignment,
          error: 'NOT_YOUR_ASSIGNMENT',
          message: 'You can only check in to an assignment that is assigned to you.',
        };
      }
    }

    // Asks the state machine rather than a local list. The list this replaced permitted
    // IN_PROGRESS -> CHECKED_IN while VALID_PATHS did not, so the two disagreed about the same
    // transition and only the one here was ever consulted.
    if (!AssignmentStateMachine.canTransition(assignment.status, AssignmentStatus.CHECKED_IN)) {
      return {
        success: false,
        assignment,
        error: 'INVALID_STATE_FOR_CHECK_IN',
        message: `You need to accept this assignment before checking in. It is currently ${String(assignment.status).replace(/_/g, ' ').toLowerCase()}.`,
      };
    }

    if (syncToken && assignment.syncToken && syncToken !== assignment.syncToken) {
      return {
        success: false,
        assignment,
        error: 'CONFLICT_ASSIGNMENT_MODIFIED',
        message: 'Assignment state has changed on server. Please refresh schedule.',
      };
    }

    // Distance from the branch, computed before anything is mutated so the geofence guard and
    // the stored evidence are one figure, not two computations that could disagree.
    const branchLat = Number(assignment.projectBranch?.branch?.latitude);
    const branchLng = Number(assignment.projectBranch?.branch?.longitude);
    const distanceMeters =
      Number.isFinite(branchLat) && Number.isFinite(branchLng) && !(branchLat === 0 && branchLng === 0)
        ? Math.round(calculateHaversineDistance(lat, lng, branchLat, branchLng) * 1000)
        : null;

    /**
     * Check-in is only honest on the scheduled day, from the branch's vicinity — enforced,
     * not merely recorded.
     *
     * Both facts were already captured (`checkInDistanceMeters`, `scheduledDate`) but nothing
     * acted on them, and production data shows the result: an assignment CHECKED_IN nine days
     * before its scheduled date, 677 km from the branch. In a bank-audit system the check-in
     * *is* the attendance evidence, so a record like that is not noise — it is a false
     * attestation the desk then relies on.
     *
     * Staff (`staffOverride`) bypass both rules: correcting a record on someone's behalf is
     * exactly the case where the guard must yield. The assayer themselves cannot.
     *
     * The date is compared as an IST calendar day. Branches and assayers are Indian; the
     * server's own timezone (UTC in the containers) must not decide which day it is in Sangli.
     */
    if (!staffOverride) {
      const scheduledIso = assignment.scheduledDate ?? assignment.projectBranch?.scheduledDate ?? null;
      if (scheduledIso) {
        const istDay = (d: Date | string) =>
          new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const today = istDay(new Date());
        const scheduled = istDay(scheduledIso);
        const dayRuleSuspended = today !== scheduled
          && (await this.ruleBypass.isBypassed(BypassableRule.CHECK_IN_SCHEDULED_DAY));
        if (dayRuleSuspended) {
          this.ruleBypass.noteBypass(BypassableRule.CHECK_IN_SCHEDULED_DAY, {
            entityType: 'ASSIGNMENT',
            entityId: assignment.id,
            userId,
            detail: `checked in on ${today}, scheduled for ${scheduled}`,
          });
        }
        if (today !== scheduled && !dayRuleSuspended) {
          const early = today < scheduled;
          return {
            success: false,
            assignment,
            error: 'NOT_SCHEDULED_TODAY',
            message: early
              ? `This audit is scheduled for ${new Date(scheduledIso).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' })}. Check-in opens on the day itself — if the visit has genuinely moved, ask operations to reschedule it first.`
              : `This audit was scheduled for ${new Date(scheduledIso).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' })} and that day has passed. Ask operations to reschedule it before checking in.`,
          };
        }
      }

      /**
       * Geofence: 2 km around the branch, widened by the device's own reported accuracy so a
       * poor rural GPS fix is not punished. 2 km is far beyond geocoding noise for a branch
       * address while still making "677 km away" impossible. Skipped when the branch has no
       * coordinates — a guard that fires on missing master data would block legitimate work.
       */
      // Configurable at /admin/settings (field.checkInGeofenceMeters). Too tight locks honest
      // workers out of their own job; too loose and check-in stops being evidence of attendance
      // — which is why it is an operator's decision rather than a redeploy.
      const GEOFENCE_METERS = await this.settings
        .getNumber('field.checkInGeofenceMeters', DEFAULT_CHECK_IN_GEOFENCE_METERS)
        .catch(() => DEFAULT_CHECK_IN_GEOFENCE_METERS);
      if (distanceMeters != null) {
        /**
         * Widened by how well we actually know where the branch IS, not just by the device's fix.
         *
         * The 2 km figure assumes the branch coordinate is good to street level. Import does not
         * guarantee that: an address it cannot resolve falls back to the city centroid
         * (`geo_accuracy_meters = 15000`) or, for an unresolvable one, the centre of India
         * (500000). An assayer standing in the doorway of a centroid-geocoded branch was then told
         * they were "8.4 km from this branch… get clear sky for a GPS fix" — blamed for a
         * coordinate the system already knew was only good to ±15 km, and unable to start the job.
         *
         * The branch's own recorded accuracy is the honest allowance, so a precisely-geocoded
         * branch keeps a tight fence and a vague one is forgiving in proportion to how vague it is.
         */
        const branchAccuracyMeters = Math.max(
          0,
          Number(assignment.projectBranch?.branch?.geoAccuracyMeters ?? 0) || 0,
        );
        /**
         * The device's reported accuracy is CLIENT-SUPPLIED and must not widen the fence without
         * limit — `{"accuracy": 5000000}` would otherwise check in from anywhere in India, and the
         * stored value would read as a bad GPS fix rather than a bypass. Real handsets in poor
         * conditions report tens to a few hundred metres; 1 km is generous. The raw figure is
         * still stored on the row (`checkInAccuracyMeters`) as evidence, unclamped.
         */
        const MAX_DEVICE_ACCURACY_ALLOWANCE_M = 1000;
        const deviceAllowance = Math.min(Math.max(0, accuracyMeters ?? 0), MAX_DEVICE_ACCURACY_ALLOWANCE_M);
        const allowance = GEOFENCE_METERS + deviceAllowance + branchAccuracyMeters;
        if (distanceMeters > allowance && await this.ruleBypass.isBypassed(BypassableRule.CHECK_IN_GEOFENCE)) {
          /**
           * Let it through, and make sure the record says so.
           *
           * The distance is stored on the row either way (see below), so the check-in is still
           * visibly out of geofence to anyone who looks. This adds the reason it was accepted —
           * without it, an out-of-range check-in in the data is indistinguishable from a GPS
           * failure, and the one question worth answering later is which of the two it was.
           */
          this.ruleBypass.noteBypass(BypassableRule.CHECK_IN_GEOFENCE, {
            entityType: 'ASSIGNMENT',
            entityId: assignment.id,
            userId,
            detail: `check-in accepted ${(distanceMeters / 1000).toFixed(1)} km from the branch`,
          });
        } else if (distanceMeters > allowance) {
          const km = (distanceMeters / 1000).toFixed(1);
          /**
           * Only blame the device when the device is the likely culprit. If the branch itself is
           * poorly geocoded, telling the assayer to find clear sky sends them chasing a fix they
           * cannot make — the coordinate on file is the thing that is wrong, and ops has to correct
           * it (Branches → the branch's location, or the geo-precision repair tools).
           */
          const branchGeoIsVague = branchAccuracyMeters >= 1000;
          return {
            success: false,
            assignment,
            error: 'TOO_FAR_FROM_BRANCH',
            message: branchGeoIsVague
              ? `You appear to be ${km} km from this branch, but this branch's recorded location is only accurate to about ${Math.round(branchAccuracyMeters / 1000)} km — it was never pinned precisely. Ask operations to correct the branch's location; this is not something you can fix from here.`
              : `You appear to be ${km} km from this branch. Check-in works only at the branch itself — if you are standing there, get clear sky for a GPS fix and try again.`,
          };
        }
      }
    }

    /**
     * Check-in position is stored in real columns, not concatenated into `remarks`.
     *
     * It used to be written only as free text — `"GPS Checked in at (12.9, 77.5) on ..."` —
     * appended to a notes field. That cannot be queried, cannot be compared against the
     * branch's own coordinates, and cannot be produced as evidence in a dispute. The distance
     * from the branch is computed and stored now, so an out-of-geofence check-in is a fact on
     * the row rather than something nobody can ever discover.
     */
    const now = new Date();
    /**
     * The FIRST check-in is the arrival record, and it is not overwritten.
     *
     * Every call used to replace `checked_in_at` and the coordinates, so checking in again later
     * — from anywhere, at any time — silently moved the recorded arrival. Attendance evidence you
     * can revise after the fact is not evidence: an assayer who arrived at 09:02 at the branch and
     * re-checked-in at 16:40 a kilometre away left a row saying only the latter, with nothing on
     * it to show it had ever said anything else.
     *
     * Re-check-ins remain accepted (the mobile app retries on flaky connections, and refusing
     * would strand someone whose first attempt failed after it had actually saved). They simply do
     * not rewrite the arrival — the position trail in `assayer_location_pings` already records
     * where the person went afterwards.
     */
    const isFirstCheckIn = !assignment.checkedInAt;
    if (isFirstCheckIn) {
      assignment.checkInLatitude = lat;
      assignment.checkInLongitude = lng;
      assignment.checkInAccuracyMeters = accuracyMeters ?? null;
      assignment.checkedInAt = now;
      assignment.checkInDistanceMeters = distanceMeters;
    }

    AssignmentStateMachine.checkIn(assignment, userId || assignment.assayerId || id);
    assignment.updatedBy = userId || assignment.assayerId || id;
    assignment.syncToken = `SYNC-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    if (assignment.projectBranch) {
      assignment.projectBranch.status = ProjectBranchStatus.SCHEDULED;
      if (!assignment.projectBranch.scheduledDate) {
        assignment.projectBranch.scheduledDate = assignment.scheduledDate || new Date();
      }
      assignment.projectBranch.updatedBy = userId || assignment.assayerId || id;
    }
    const saved = await this.dataSource.transaction(async (manager) => {
      if (assignment.projectBranch) {
        await manager.save(assignment.projectBranch);
      }
      if (assignment.assessment) {
        await manager.save(assignment.assessment);
      }
      return manager.save(assignment);
    });

    /**
     * The check-in also lands in the movement trail.
     *
     * This is the anchor of every travel assessment: the one moment the platform knows for certain
     * where an assayer was, verified against the branch geofence and captured under a human
     * action. A journey is judged backwards from it (LocationTrailService.assessAssignmentTravel),
     * so without this fix in the trail the approach has no end point to be measured against.
     *
     * Appended after the transaction and best-effort inside `record()`: supporting evidence must
     * never be able to fail the check-in it accompanies.
     */
    await this.locationTrail
      .record(saved.assayerId, lat, lng, {
        source: LocationPingSource.CHECK_IN,
        accuracyMeters: accuracyMeters ?? null,
        assignmentId: saved.id,
        recordedAt: now,
        recordedBy: userId || saved.assayerId,
      })
      // Guarded here as well as inside `record()`. An assayer standing at the branch must not be
      // refused because a supporting write failed, and that promise is too important to hold only
      // in a collaborator's implementation — it has to be true at the call site regardless.
      .catch((err) =>
        console.error(`Check-in recorded but its trail fix was not stored (${saved.id}):`, err),
      );

    // Record Audit Event for real-time operations control tracking
    try {
      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: 'ASSIGNMENT_CHECKED_IN',
        entityType: 'ASSIGNMENT',
        entityId: saved.id,
        userId: userId || saved.assayerId,
        remarks: `Assayer ${saved.assayer?.displayName || ''} GPS checked in at branch ${saved.projectBranch?.branch?.name || ''} (${lat}, ${lng}).`,
      });
    } catch (err) {
      console.error('Failed to log check-in audit event:', err);
    }

    // Send real-time notification to assignment creator / operations manager
    if (saved.createdBy) {
      try {
        const targetUser = await this.dataSource.getRepository(UserEntity).findOne({ where: { id: saved.createdBy } }).catch(() => null);
        if (targetUser) {
          await this.notificationService.create({
            userId: saved.createdBy,
            title: 'Assayer GPS Check-In',
            message: `Assayer ${saved.assayer?.displayName || 'Field Assayer'} checked in at ${saved.projectBranch?.branch?.name || 'Branch'} (${lat}, ${lng}).`,
            // Left as a direct create rather than migrated to a catalog emit: the catalog has no
            // check-in type, and inventing one here would change who gets told (roles, not the
            // raiser) — a routing decision that belongs with the catalog, not this call site.
            // The link is corrected: `/assignments/:id` is not a frontend route, so every one of
            // these landed on the dashboard catch-all instead of the record.
            link: `/assignments?id=${saved.id}`,
          }, userId || saved.assayerId);
        }
      } catch (err) {
        console.error('Failed to dispatch check-in notification:', err);
      }
    }

    return {
      success: true,
      assignment: saved,
      message: `Checked in at ${lat}, ${lng}`,
    };
  }
}

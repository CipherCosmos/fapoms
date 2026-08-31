import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { AssayerEntity, AssayerWithWorkforceAttributes } from '../assayer/assayer.entity';
import { AssayerService } from '../assayer/assayer.service';
import { BranchEntity } from '../branch/branch.entity';
import { RoutingService, RouteSource } from '../geo/routing.provider';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { BusinessRuleEntity } from '../platform/rules/business-rule.entity';
import { AssignmentStatus, AssayerStatus, AssayerLifecycleStatus, calculateHaversineDistance, businessDateKey, BypassableRule } from '@fapoms/shared';
import { RuleBypassService } from '../platform/rule-bypass/rule-bypass.service';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ClientEntity } from '../client/client.entity';
import { RuleEngine } from '../platform/rules/rule.engine';
import { ConfigurationResolver } from '../platform/configuration/configuration.resolver';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { ConstraintEvaluator } from './constraint.evaluator';
import { COMMITTED_ASSIGNMENT_STATUSES, DEFAULT_WEEKLY_CAPACITY } from '../assignment/assignment-workload';
import { AssayerRemarksService } from '../assayer-remarks/assayer-remarks.service';
import {
  DEFAULT_FAIRNESS_OFFER_CAP,
  FAIRNESS_OFFER_CAP_SETTING,
  FAIRNESS_OFFER_WINDOW_DAYS,
  RemarkForScoring,
  RemarkSummary,
  fairnessScoreFrom,
  remarksScoreFrom,
  summariseRemarks,
} from '../assayer-remarks/assayer-remark.contract';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';

/**
 * Human-readable reason per filter name. Ops sees these, not internal filter identifiers.
 */
const EXCLUSION_REASONS: Record<string, string> = {
  deployable: 'Onboarding not finished — not yet assignable',
  availability: 'Unavailable on this date (already booked or on leave)',
  consecutiveBranchAudit: 'Audited this branch most recently — rotation rule prevents repeat auditor',
  clientRestriction: 'Restricted by this client',
  clientEligibility: 'Not approved to work for this client — not on its approved list, or their empanelment with it is rejected, terminated or not recommended',
  ruleEngineEligibility: 'Blocked by a business rule',
  requiredSkills: 'Missing a skill or certification this project requires',
  distancePolicy: "Outside the client's permitted distance band for this branch",
};

/**
 * What KIND of exclusion each filter produces — because they are not equally final.
 * A DATE exclusion (booked that day, on leave) is a perfectly good candidate for another
 * date and should be offered as such, not buried; SKILLS/POLICY exclusions are structural.
 * ONBOARDING is neither: the person is real and near the branch, they simply have not been
 * walked to the end of the HR onboarding path yet, and the fix is a click on the roster.
 */
const EXCLUSION_KINDS: Record<string, 'DATE' | 'ROTATION' | 'DISTANCE' | 'POLICY' | 'SKILLS' | 'ONBOARDING'> = {
  deployable: 'ONBOARDING',
  availability: 'DATE',
  consecutiveBranchAudit: 'ROTATION',
  distancePolicy: 'DISTANCE',
  clientRestriction: 'POLICY',
  clientEligibility: 'POLICY',
  ruleEngineEligibility: 'POLICY',
  requiredSkills: 'SKILLS',
};

/**
 * Lifecycle stages an assayer passes through before they are assignable.
 *
 * `AssayerService.create` opens every new profile at INVITED / status INACTIVE, and each
 * planning query then asked for `status = ACTIVE` — so a just-added assayer was not merely
 * ineligible, they never entered the candidate pool at all and no exclusion reason was recorded
 * for them. Ops saw "No assayers found in range for this date" for someone they had added
 * minutes earlier and who was plainly visible on the HR roster.
 *
 * Candidates in these stages are pulled into the pool deliberately, so the engine can say what
 * is actually wrong and where to fix it. They are still excluded from the eligible list —
 * dispatching unverified, untrained people is the control this lifecycle exists to enforce.
 */
const ONBOARDING_LIFECYCLE_STATES: string[] = [
  AssayerLifecycleStatus.INVITED,
  AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
  AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
  AssayerLifecycleStatus.TRAINING,
];

/** Human-readable next step per onboarding stage, so the exclusion is actionable. */
const ONBOARDING_NEXT_STEP: Record<string, string> = {
  [AssayerLifecycleStatus.INVITED]: 'invited — start document verification on the HR roster',
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: 'in document verification — complete it on the HR roster',
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: 'in background verification — complete it on the HR roster',
  [AssayerLifecycleStatus.TRAINING]: 'in training — mark training complete on the HR roster to activate',
};

export interface PlanningContext {
  branch: BranchEntity;
  client: ClientEntity | null;
  scheduledDate: Date;
  weights: Record<string, number>;
  /**
   * Treat the date-bound checks (already booked, on leave) as advisory rather than
   * disqualifying, so the operator sees the whole nearby workforce and decides for themselves.
   *
   * Ops asked for this because the date filter answers a narrower question than the one they
   * are usually asking: on a first pass they want to know *who could do this branch at all*,
   * and a diary clash on one candidate date is something they resolve by moving the date, not
   * by removing the person. Candidates kept this way carry `dateConflict` so the clash is still
   * stated on the row — relaxed, not hidden. Deployability (onboarding, active status) is NOT
   * relaxed by this: that is a control, not a preference.
   */
  relaxAvailability?: boolean;
  /**
   * Facts about the branch itself, resolved once per recommendation rather than once per
   * candidate.
   *
   * Several filters and scorers issue their own query for every assayer in the pool, and some
   * of those queries do not depend on the assayer at all — the no-repeat-auditor rule looks up
   * *this branch's* most recent assignment identically for all of them. With a national
   * workforce that is one wasted round trip per assayer, per recommendation, and it grows with
   * headcount rather than with anything meaningful.
   *
   * Optional so a filter used outside recommend() still works standalone; each consumer falls
   * back to querying when it is absent.
   */
  branchFacts?: {
    /** Most recent assignment on this branch, or null if it has never been audited. */
    lastAssignment: { assayerId: string; status: AssignmentStatus } | null;
    /** Committed workload per assayer id, for every candidate in the pool. */
    activeWorkloadByAssayer: Record<string, number>;
    /**
     * Branch-to-assayer route, computed once per candidate.
     *
     * The distance and travel-time scorers each called `calculateRoute` with the identical
     * origin and destination, so every candidate was routed twice — and routing is the most
     * expensive thing in this pipeline, since it can reach an external provider. Sharing one
     * result halves the calls and makes the ranking self-consistent: the two scores can no
     * longer disagree because they were computed from separate responses.
     *
     * `source` says whether the figures are road figures ('OSRM') or a straight-line estimate
     * ('ESTIMATE'); anything that shows a distance to a person must carry that label through.
     */
    routeByAssayer: Record<string, { distanceKm: number; durationMinutes: number; source: RouteSource }>;
    /** The project-branch row for this branch — identical for every candidate. */
    projectBranch?: any;
    /**
     * Every active commercial profile per assayer, newest effective date first.
     *
     * The cost and profitability scorers each queried this table per candidate, and they
     * select from it differently — cost takes the profile in force on the scheduled date,
     * profitability takes the most recent regardless of date. Both rules are preserved exactly
     * here; the rows are simply fetched once instead of 2N times. That the two disagree about
     * which fee applies is a real inconsistency, but correcting it would move scores, so it is
     * left visible rather than folded in silently.
     */
    commercialProfilesByAssayer: Record<string, any[]>;
    /** Clarification queries raised against each assayer. */
    queryCountByAssayer: Record<string, number>;
    /** Lifetime assignment counts per assayer: everything dispatched, and everything taken. */
    assignmentTotalsByAssayer: Record<string, { total: number; accepted: number }>;
    /**
     * Assayers already committed on the scheduled date, mapped to the assignment that holds
     * them. Double-booking was one findOne per candidate asking the same date question.
     */
    doubleBookedByAssayer: Record<string, string>;
    /** Recent completed assignments per assayer, for the delivery-speed score. */
    completedByAssayer: Record<string, Array<{ completionDate: Date | null; createdAt: Date }>>;
    /**
     * The business rules that apply to this branch and client, loaded once.
     *
     * They do not depend on the assayer, yet the eligibility filter asked the database for them
     * once per candidate — and again per blocked candidate when `explain()` re-ran the same
     * evaluation for its reasons. On a pool of 300 that is 300+ identical queries per
     * recommendation.
     */
    rules: BusinessRuleEntity[];
    /** Times each assayer has already audited THIS branch (accepted or completed). */
    priorVisitsByAssayer: Record<string, number>;
    /**
     * Empanelment standing with THIS branch's client, per assayer — only rows that exist.
     * Consulted by ClientEligibilityFilter: an explicitly negative standing (REJECTED,
     * TERMINATED, NOT_RECOMMENDED) excludes; every other status, and no row at all, changes
     * nothing. Absent-by-default keeps today's behaviour for the untracked majority.
     */
    empanelmentStatusByAssayer?: Record<string, string>;
    /**
     * How many assignments each assayer has already ACCEPTED for the scheduled day, and where
     * those branches are. Both were per-candidate queries that compared a `date` column against
     * a JavaScript Date carrying a time — a comparison Postgres never satisfies — so the
     * same-day overload penalty and the same-day grouping bonus have both been inert. Resolved
     * here through the same date-only key the double-booking guard uses, which makes the two
     * rules start applying; see the commit that introduced this.
     */
    sameDayAcceptedCountByAssayer: Record<string, number>;
    sameDayBranchPointsByAssayer: Record<string, Array<{ latitude: number; longitude: number }>>;
    /**
     * Staff remarks about each candidate from the last 365 days, rated ones only, newest first.
     *
     * Loaded for the whole pool in ONE query through AssayerRemarksService.loadScoringWindow —
     * never per candidate. The remarks scorer reads this; the candidate row also carries a
     * summary of it (count, recency-weighted mean, latest remark) so the card can show what
     * moved the number. Optional so a context built before this fact existed still type-checks
     * and the scorer falls back to its own (single-assayer) query.
     */
    remarksByAssayer?: Record<string, RemarkForScoring[]>;
    /**
     * Assignments offered to each candidate in the last 30 days, any status, live rows only.
     * One grouped count for the pool. The fairness scorer reads this — see
     * FairnessScoreCalculator for why it is a nudge and not a quota.
     */
    recentOffersByAssayer?: Record<string, number>;
    /**
     * `planning.fairnessOfferCap`, resolved once per recommendation rather than once per
     * candidate; the platform-settings read is cached but it is still an await per call.
     */
    fairnessOfferCap?: number;
  };
}

export interface CandidateFilter {
  name: string;
  evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean>;
}

export interface ScoreCalculator {
  name: string;
  calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}

/**
 * Is this person assignable at all, on any date?
 *
 * Split out of AvailabilityFilter because the two answer different questions and the operator
 * needs to tell them apart. "Booked on Tuesday" and "has not finished background verification"
 * were both reported as *Unavailable on this date*, which sent ops looking for another date for
 * someone who has no dates at all. This runs first so an onboarding candidate is reported as
 * such, and — unlike the date checks — it is never relaxed.
 */
@Injectable()
export class DeployabilityFilter implements CandidateFilter {
  name = 'deployable';

  constructor(private readonly ruleBypass: RuleBypassService) {}

  async evaluate(assayer: AssayerEntity): Promise<boolean> {
    if (assayer.isActive && assayer.status === AssayerStatus.ACTIVE) return true;
    /**
     * A deleted profile is never selectable, bypass or not. Suspending onboarding is a
     * statement about vetting being incomplete; it is not a statement that a record somebody
     * removed from the workforce should come back.
     */
    if (!assayer.isActive) return false;
    if (await this.ruleBypass.isBypassed(BypassableRule.ASSAYER_ONBOARDING)) {
      this.ruleBypass.noteBypass(BypassableRule.ASSAYER_ONBOARDING, {
        entityType: 'ASSAYER',
        entityId: assayer.id,
        detail: `offered as a candidate at lifecycle ${assayer.lifecycleStatus}`,
      });
      return true;
    }
    return false;
  }

  /** Why they are not assignable, and what to do about it. */
  explain(assayer: AssayerEntity): string {
    if (!assayer.isActive) {
      return 'Profile has been deleted from the workforce — restore it on the HR roster to use them.';
    }
    const step = ONBOARDING_NEXT_STEP[assayer.lifecycleStatus];
    if (step) return `Onboarding not finished: ${step}.`;
    return `Not assignable — profile status is ${assayer.status} (${assayer.lifecycleStatus}).`;
  }
}

@Injectable()
export class AvailabilityFilter implements CandidateFilter {
  name = 'availability';

  constructor(
    private readonly constraintEvaluator: ConstraintEvaluator,
  ) {}

  async evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean> {
    /**
     * Deployability is not re-judged here.
     *
     * This used to reject anyone whose status was not ACTIVE, described as a backstop for
     * standalone callers — there are none; DeployabilityFilter is registered ahead of this one in
     * the only pipeline that runs it. What the duplicate actually did was silently undo the
     * administrator's ASSAYER_ONBOARDING bypass: deployability let an onboarding assayer through
     * as instructed, and this line rejected them one step later under a reason that is a
     * statement about a particular day — "already booked or on leave" — for someone with no
     * bookings and no leave. The bypass looked broken and the exclusion panel lied about why.
     *
     * One filter owns one question. Whether this person can be sent anywhere at all is
     * DeployabilityFilter's; whether they are free on this date is this one's.
     */

    // Both checks below are about one specific day. When the operator has asked to see the
    // whole workforce regardless of that day, they stop disqualifying and are reported on the
    // candidate row instead — see PlanningContext.relaxAvailability.
    if (context.relaxAvailability) return true;

    // 1. Check double booking
    // Resolved for the whole pool in one query when recommend() supplied the facts; the
    // per-candidate check remains for standalone use.
    if (context.branchFacts) {
      if (context.branchFacts.doubleBookedByAssayer[assayer.id]) return false;
    } else {
      const dbResult = await this.constraintEvaluator.checkDoubleBooking(assayer.id, context.scheduledDate);
      if (!dbResult.passed) return false;
    }

    // 2. Check leaves
    const leaveResult = this.constraintEvaluator.checkLeaves(assayer, context.scheduledDate);
    if (!leaveResult.passed) {
      return false;
    }

    return true;
  }
}

@Injectable()
export class ConsecutiveBranchAuditFilter implements CandidateFilter {
  name = 'consecutiveBranchAudit';

  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly ruleBypass: RuleBypassService,
  ) {}

  async evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean> {
    if (!context.branch?.id) return true;

    // The branch's last assignment is the same answer for every candidate, so recommend()
    // resolves it once and passes it here. Falling back to the query keeps this filter usable
    // on its own.
    const lastAssignment = context.branchFacts
      ? context.branchFacts.lastAssignment
      : await this.assignmentRepository.findOne({
          where: {
            projectBranch: { branchId: context.branch.id },
            isActive: true,
          },
          order: { createdAt: 'DESC' },
          relations: ['projectBranch'],
        });

    if (!lastAssignment) return true; // No prior audit recorded for this branch

    // Only block the assayer once they're actually locked in (ACCEPTED) or have already
    // completed this branch's audit (anti-collusion / no-repeat-auditor rule). A still-PENDING
    // offer awaiting response — or one that was REJECTED/CANCELLED — should not prevent the same
    // assayer from still showing up as a recommendable backup candidate.
    const locksOutCandidate = [AssignmentStatus.ACCEPTED, AssignmentStatus.COMPLETED].includes(lastAssignment.status);
    if (lastAssignment.assayerId === assayer.id && locksOutCandidate) {
      if (this.ruleBypass.isBypassedSync(BypassableRule.REPEAT_AUDITOR_ROTATION)) {
        this.ruleBypass.noteBypass(BypassableRule.REPEAT_AUDITOR_ROTATION, {
          entityType: 'BRANCH', entityId: context.branch.id,
          detail: `${assayer.displayName} audited this branch most recently`,
        });
        return true;
      }
      return false;
    }

    return true;
  }
}

/**
 * The client's territorial rules as an exclusion, not a discount.
 *
 * `minDistanceKm` is a conflict-of-interest floor: an assayer must be far enough from the
 * branch they audit. The day planner has always enforced it by dropping the candidate, but this
 * path only subtracted 40 points, so a disqualified assayer still appeared on the list — merely
 * lower down — and could be assigned. Scoring cannot express "not allowed".
 */
@Injectable()
export class DistancePolicyFilter implements CandidateFilter {
  name = 'distancePolicy';

  constructor(private readonly constraintEvaluator: ConstraintEvaluator) {}

  async evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean> {
    const preferences = context.client?.planningPreferences;
    if (!preferences) return true;
    /**
     * Measured from the assayer's registered home, not their live position. The floor asks how
     * close this person lives to the branch they would audit — a structural fact about conflict
     * of interest. Measuring it from wherever their phone happened to be would let someone
     * disqualified by where they live pass simply by travelling, and would make the same
     * candidate eligible or not depending on the hour.
     */
    if (
      context.branch?.latitude == null || context.branch?.longitude == null ||
      assayer.homeLatitude == null || assayer.homeLongitude == null
    ) {
      return true;
    }

    const distance = calculateHaversineDistance(
      Number(context.branch.latitude),
      Number(context.branch.longitude),
      Number(assayer.homeLatitude),
      Number(assayer.homeLongitude),
    );

    /**
     * The floor only. `minDistanceKm` is a compliance control — an assayer must not audit a
     * branch on their own doorstep — so it is never negotiable and is enforced by exclusion.
     *
     * `maxDistanceKm` is a serviceability preference, not a control: the day planner treats it
     * as relaxable and widens the search when nothing is reachable. This path has no such
     * relaxation, so excluding on it would leave ops with an empty list and no way to reopen it
     * — on live data it cut a 26-candidate list to 2. The ceiling therefore stays a scoring
     * penalty here (ClientPreferenceScoreCalculator), which ranks distant assayers last while
     * still letting ops see and choose them.
     */
    return this.constraintEvaluator.checkDistancePolicy(preferences, distance, { relaxDistance: true }).passed;
  }
}

@Injectable()
export class ClientRestrictionFilter implements CandidateFilter {
  name = 'clientRestriction';

  constructor(private readonly ruleBypass: RuleBypassService) {}

  async evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean> {
    if (!context.client) return true;
    const restricted = context.client.restrictedAssayers || [];
    if (!restricted.includes(assayer.id)) return true;
    if (this.ruleBypass.isBypassedSync(BypassableRule.CLIENT_ELIGIBILITY)) {
      this.ruleBypass.noteBypass(BypassableRule.CLIENT_ELIGIBILITY, {
        entityType: 'ASSAYER', entityId: assayer.id,
        detail: `barred by ${context.client.clientCode ?? context.client.name}`,
      });
      return true;
    }
    return false;
  }
}

@Injectable()
export class ClientEligibilityFilter implements CandidateFilter {
  name = 'clientEligibility';

  constructor(private readonly ruleBypass: RuleBypassService) {}

  async evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean> {
    if (!context.client) return true;

    // An explicitly negative empanelment is the client's own recorded "no" — REJECTED,
    // TERMINATED or NOT_RECOMMENDED excludes, with the usual bypass escape hatch. Any other
    // standing, and no row at all, decides nothing: the legacy eligibleClients check below
    // proceeds untouched, so nobody currently eligible loses work except the explicitly barred.
    const standing = context.branchFacts?.empanelmentStatusByAssayer?.[assayer.id];
    if (standing === 'REJECTED' || standing === 'TERMINATED' || standing === 'NOT_RECOMMENDED') {
      if (this.ruleBypass.isBypassedSync(BypassableRule.CLIENT_ELIGIBILITY)) {
        this.ruleBypass.noteBypass(BypassableRule.CLIENT_ELIGIBILITY, {
          entityType: 'ASSAYER', entityId: assayer.id,
          detail: `empanelment ${standing} by ${context.client.clientCode ?? context.client.name}`,
        });
      } else {
        return false;
      }
    }

    const eligible = assayer.eligibleClients || [];
    if (eligible.length === 0 || eligible.includes('*') || eligible.includes('ANY') || eligible.includes('ALL')) {
      return true;
    }
    if (eligible.includes(context.client.clientCode) || eligible.includes(context.client.id)) return true;
    if (this.ruleBypass.isBypassedSync(BypassableRule.CLIENT_ELIGIBILITY)) {
      this.ruleBypass.noteBypass(BypassableRule.CLIENT_ELIGIBILITY, {
        entityType: 'ASSAYER', entityId: assayer.id,
        detail: `not on ${context.client.clientCode ?? context.client.name}'s approved list`,
      });
      return true;
    }
    return false;
  }
}

@Injectable()
export class RuleEngineEligibilityFilter implements CandidateFilter {
  name = 'ruleEngineEligibility';

  constructor(
    private readonly ruleEngine: RuleEngine,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly ruleBypass: RuleBypassService,
  ) {}

  async evaluate(assayerEntity: AssayerEntity, context: PlanningContext): Promise<boolean> {
    const assayer = assayerEntity as AssayerWithWorkforceAttributes;

    // A CAPACITY rule compares against `activeWorkload`, which was never supplied here — so it
    // always read 0 and no capacity limit could ever trigger. Counting committed work makes
    // that rule type enforceable.
    // One grouped count for the whole pool is resolved by recommend() and read from context;
    // this per-candidate count is the standalone fallback.
    const activeWorkload = context.branchFacts
      ? (context.branchFacts.activeWorkloadByAssayer[assayer.id] ?? 0)
      : await this.assignmentRepository.count({
          where: {
            assayerId: assayer.id,
            status: In(COMMITTED_ASSIGNMENT_STATUSES),
            isActive: true,
          },
        });

    const results = await this.ruleEngine.evaluate({
      subject: {
        id: assayer.id,
        state: assayer.state,
        skills: assayer.skills || [],
        certifications: (assayer.certifications || []).map((c) => ({ name: c.name, expiryDate: c.expiryDate ?? undefined })),
      },
      target: {
        id: context.branch.id,
        clientId: context.branch.clientId,
      },
      scheduledDate: context.scheduledDate,
      activeWorkload,
      restrictedAssayers: context.client?.restrictedAssayers,
    }, context.branchFacts?.rules);
    // If any active rule block action fails, return false
    const blocked = results.some((r) => !r.passed && r.actionType === 'BLOCK');
    if (blocked && this.ruleBypass.isBypassedSync(BypassableRule.BUSINESS_RULE_ENGINE)) {
      this.ruleBypass.noteBypass(BypassableRule.BUSINESS_RULE_ENGINE, {
        entityType: 'ASSAYER', entityId: assayer.id,
        detail: results.filter((r) => !r.passed && r.actionType === 'BLOCK').map((r) => r.message).join('; '),
      });
      return true;
    }
    return !blocked;
  }

  /**
   * Same evaluation, but returns the human-readable reasons a candidate was blocked.
   * Ops needs "why is my best assayer missing?" answered — a silently shorter list is the
   * least useful possible output.
   */
  async explain(assayerEntity: AssayerEntity, context: PlanningContext): Promise<string[]> {
    const assayer = assayerEntity as AssayerWithWorkforceAttributes;
    // One grouped count for the whole pool is resolved by recommend() and read from context;
    // this per-candidate count is the standalone fallback.
    const activeWorkload = context.branchFacts
      ? (context.branchFacts.activeWorkloadByAssayer[assayer.id] ?? 0)
      : await this.assignmentRepository.count({
          where: {
            assayerId: assayer.id,
            status: In(COMMITTED_ASSIGNMENT_STATUSES),
            isActive: true,
          },
        });
    const results = await this.ruleEngine.evaluate({
      subject: {
        id: assayer.id,
        state: assayer.state,
        skills: assayer.skills || [],
        certifications: (assayer.certifications || []).map((c) => ({ name: c.name, expiryDate: c.expiryDate ?? undefined })),
      },
      target: { id: context.branch.id, clientId: context.branch.clientId },
      scheduledDate: context.scheduledDate,
      activeWorkload,
      restrictedAssayers: context.client?.restrictedAssayers,
    }, context.branchFacts?.rules);
    return results
      .filter((r) => !r.passed && r.actionType === 'BLOCK')
      .map((r) => r.message || 'Blocked by a business rule');
  }
}

@Injectable()
export class RequiredSkillsFilter implements CandidateFilter {
  name = 'requiredSkills';

  constructor(
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
    private readonly constraintEvaluator: ConstraintEvaluator,
  ) {}

  async evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean> {
    // Same row for every candidate, so recommend() resolves it once. The query remains as a
    // standalone fallback.
    const pb = context.branchFacts?.projectBranch !== undefined
      ? context.branchFacts.projectBranch
      : await this.projectBranchRepository.findOne({
          where: { branchId: context.branch.id, isActive: true },
          relations: ['project'],
        });

    if (!pb || !pb.project) {
      return true;
    }

    const checkResult = this.constraintEvaluator.checkSkillsAndCertifications(assayer, pb.project, context.scheduledDate);
    return checkResult.passed;
  }
}

/**
 * Distance → score, 0–100: `100 · e^(−km / 200)`.
 *
 * Until August 2026 this was `100 − km/5`, a straight line that hit zero at 500 km. Two things
 * were wrong with it, and both got worse the moment the kilometres became real road distances
 * (which run 11–56 % longer than the straight line they replaced — see routing.provider.ts):
 *
 *   - It stopped discriminating exactly where discrimination is scarce. Every candidate 500 km
 *     or further scored the same zero, so 500 km and 1,250 km were tied. On this deployment
 *     the only person holding the attributes a gold-audit project needs can be 1,200 km away
 *     (see the note in `recommend()`), and a scorer that cannot tell 600 from 1,200 is no help
 *     in choosing between the two people who can actually do the job.
 *   - It was too gentle near home. 30 km scored 94 and 100 km scored 80 — a fourteen-point
 *     gap for the difference between a local visit and a day trip, while 400 → 500 km, which
 *     nobody would weigh, was worth twenty points.
 *
 * The exponential fixes both. It never reaches zero, so any two candidates stay ordered by
 * distance however far away they are; and it is steep where the decision is real:
 *
 *      km:    0    30    50   100   139   200   250   500  1000
 *   score:  100    86    78    61    50    37    29     8   0.7
 *
 * 200 km was chosen because it is the scale of the decision: about 2 h 45 min by road at the
 * ~72 km/h the seven measured pairs average, i.e. the point past which an audit becomes an
 * overnight trip. Halving distance is worth the same everywhere on this curve (each 139 km
 * halves the score), which is how ops think about it — 50 vs 190 km is a big deal, 800 vs
 * 940 km barely matters, both are a flight or a night away.
 *
 * Rejected: a steeper `e^(−km/100)` (a 250 km candidate would score 8, indistinguishable from
 * 500 km at the weights in use); a piecewise-linear knee (adds parameters for no gain the
 * exponential does not already give); leaving it linear and only widening the zero point (still
 * ties everyone beyond it).
 */
@Injectable()
export class DistanceScoreCalculator implements ScoreCalculator {
  name = 'distance';

  constructor(private readonly routingService: RoutingService) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    if (!context.branch.latitude || !context.branch.longitude || !assayer.effectiveLatitude || !assayer.effectiveLongitude) {
      return 0;
    }
    const route = context.branchFacts?.routeByAssayer[assayer.id]
      ?? await this.routingService.calculateRoute(
        { latitude: context.branch.latitude, longitude: context.branch.longitude },
        { latitude: assayer.effectiveLatitude, longitude: assayer.effectiveLongitude },
      );
    return distanceScore(route.distanceKm);
  }
}

/** See `DistanceScoreCalculator`. Exported so the curve is testable without a routing double. */
export function distanceScore(distanceKm: number): number {
  const km = Number(distanceKm);
  if (!Number.isFinite(km)) return 0;
  if (km <= 0) return 100;
  return Math.min(100, Math.max(0, 100 * Math.exp(-km / 200)));
}

/**
 * Travel time → score, 0–100: `100 · e^(−minutes / 170)`.
 *
 * The same shape as the distance curve, for the same reasons (the old `100 − min/6` was zero
 * at ten hours and flat beyond, and gentle where it should have been steep). The scale is set
 * so that the two curves agree for a typical road: the seven measured pairs in
 * routing.provider.ts average ~72 km/h door to door, at which 200 km is 167 minutes — rounded
 * to 170, so a candidate scores about the same on both dimensions unless the road is unusually
 * slow or fast for its length. That is deliberate: when this diverges from the distance score
 * it is *because* the terrain is slow (the Idukki pair: 275 km but 4 h 36 min), and that is the
 * signal the travel-time dimension exists to carry, not a second copy of distance.
 *
 *     min:    0    30    60    90   118   170   240   300   600
 *   score:  100    84    70    59    50    37    24    17     3
 *
 * With `source: 'ESTIMATE'` the minutes are straight-line ÷ 40 km/h; the score is still
 * bounded and monotone, it is simply less informative, and the label travels with the route.
 */
@Injectable()
export class TravelTimeScoreCalculator implements ScoreCalculator {
  name = 'travelTime';

  constructor(private readonly routingService: RoutingService) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    if (!context.branch.latitude || !context.branch.longitude || !assayer.effectiveLatitude || !assayer.effectiveLongitude) {
      return 0;
    }
    // Shared with the distance scorer — see branchFacts.routeByAssayer.
    const route = context.branchFacts?.routeByAssayer[assayer.id]
      ?? await this.routingService.calculateRoute(
        { latitude: context.branch.latitude, longitude: context.branch.longitude },
        { latitude: assayer.effectiveLatitude, longitude: assayer.effectiveLongitude },
      );
    return travelTimeScore(route.durationMinutes);
  }
}

/** See `TravelTimeScoreCalculator`. */
export function travelTimeScore(durationMinutes: number): number {
  const minutes = Number(durationMinutes);
  if (!Number.isFinite(minutes)) return 0;
  if (minutes <= 0) return 100;
  return Math.min(100, Math.max(0, 100 * Math.exp(-minutes / 170)));
}

@Injectable()
export class WorkloadScoreCalculator implements ScoreCalculator {
  name = 'workload';

  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
  ) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    // Committed work, matching every other capacity reader. Counting ACCEPTED alone treated an
    // assayer who was checked in at a branch, or mid-audit, as completely free.
    // The same grouped count the eligibility filter reads; the per-candidate count below is the
    // standalone fallback.
    const activeCount = context.branchFacts
      ? (context.branchFacts.activeWorkloadByAssayer[assayer.id] ?? 0)
      : await this.assignmentRepository.count({
          where: {
            assayerId: assayer.id,
            status: In(COMMITTED_ASSIGNMENT_STATUSES),
            isActive: true,
          },
        });

    const maxCapacity = assayer.maxWeeklyWorkload || DEFAULT_WEEKLY_CAPACITY;
    const remaining = Math.max(0, maxCapacity - activeCount);
    return Math.min(100, (remaining / maxCapacity) * 100);
  }
}

@Injectable()
export class PerformanceScoreCalculator implements ScoreCalculator {
  name = 'performance';

  async calculate(assayer: AssayerEntity): Promise<number> {
    // `== null ? 5 : Number(...)` and never `|| 5`: the column is numeric(3,2), so TypeORM hands
    // back a string, and `Number("0.00") || 5.0` silently turns a genuine zero rating into a
    // perfect one. Zero means zero.
    //
    // NULL now means unrated, and unrated scores NEUTRAL — the same 50 every other dimension
    // uses for "no signal". It used to mean 5.0, i.e. full marks: nobody had assessed these
    // people, and the engine read that as the best possible assessment.
    if (assayer.performanceRating == null) return 50;
    const rating = Number(assayer.performanceRating);
    return (rating / 5.0) * 100;
  }
}

@Injectable()
export class RejectionAcceptanceScoreCalculator implements ScoreCalculator {
  name = 'acceptanceRate';

  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
  ) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    // Both counts for the whole pool arrive in one grouped query; the per-candidate pair below
    // remains for standalone use.
    const shared = context?.branchFacts?.assignmentTotalsByAssayer[assayer.id];
    if (shared) {
      if (shared.total === 0) return 85;
      return Math.round((shared.accepted / shared.total) * 100);
    }

    const totalDispatched = await this.assignmentRepository.count({
      where: { assayerId: assayer.id, isActive: true },
    });

    if (totalDispatched === 0) return 85; // Baseline default for new assayers

    const acceptedCount = await this.assignmentRepository.count({
      where: {
        assayerId: assayer.id,
        status: In([AssignmentStatus.ACCEPTED, AssignmentStatus.COMPLETED]),
        isActive: true,
      },
    });

    return Math.round((acceptedCount / totalDispatched) * 100);
  }
}

@Injectable()
export class DeliverySpeedScoreCalculator implements ScoreCalculator {
  name = 'deliverySpeed';

  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
  ) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    // The whole pool's completed history arrives in one query; this per-candidate fetch stays
    // for standalone use.
    const completedAssignments = context?.branchFacts
      ? (context.branchFacts.completedByAssayer[assayer.id] ?? [])
      : await this.assignmentRepository.find({
          where: {
            assayerId: assayer.id,
            status: AssignmentStatus.COMPLETED,
            isActive: true,
          },
          take: 20,
        });

    if (completedAssignments.length === 0) return 80;

    let totalScore = 0;
    for (const a of completedAssignments) {
      if (a.completionDate && a.createdAt) {
        const diffHours = (new Date(a.completionDate).getTime() - new Date(a.createdAt).getTime()) / (1000 * 3600);
        if (diffHours <= 24) totalScore += 100;
        else if (diffHours <= 48) totalScore += 80;
        else if (diffHours <= 72) totalScore += 60;
        else totalScore += 40;
      } else {
        totalScore += 75;
      }
    }

    return Math.round(totalScore / completedAssignments.length);
  }
}

@Injectable()
export class QueryVolumeScoreCalculator implements ScoreCalculator {
  name = 'queryVolume';

  constructor(
    @InjectRepository(ValidationQueryEntity)
    private readonly queryRepository: Repository<ValidationQueryEntity>,
  ) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    const sharedQueryCount = context?.branchFacts?.queryCountByAssayer[assayer.id];
    if (sharedQueryCount !== undefined) {
      if (sharedQueryCount === 0) return 95;
      return Math.max(20, Math.round(100 - (sharedQueryCount * 10)));
    }

    const queries = await this.queryRepository.find({
      where: { assayerId: assayer.id, isActive: true },
      take: 50,
    });

    if (queries.length === 0) return 95; // Excellent score: 0 queries raised for this assayer

    // Deduct points per raised validation query
    return Math.max(20, Math.round(100 - (queries.length * 10)));
  }
}

@Injectable()
export class ExperienceScoreCalculator implements ScoreCalculator {
  name = 'experience';

  async calculate(assayer: AssayerEntity): Promise<number> {
    const exp = assayer.experienceYears || 0;
    return Math.min(100, (exp / 10) * 100);
  }
}

function getCityTierMultiplier(city?: string): number {
  if (!city) return 1.0;
  const c = city.trim().toLowerCase();
  const tier1 = ['mumbai', 'delhi', 'bangalore', 'bengaluru', 'chennai', 'kolkata', 'hyderabad', 'pune', 'ahmedabad', 'gurgaon', 'gurugram', 'noida'];
  if (tier1.includes(c)) return 1.5;
  const tier2 = ['jaipur', 'lucknow', 'patna', 'bhopal', 'nagpur', 'indore', 'coimbatore', 'kochi', 'visakhapatnam', 'chandigarh', 'surat', 'vadodara', 'ludhiana', 'agra', 'nashik', 'meerut', 'rajkot', 'varanasi', 'srinagar', 'aurangabad', 'amritsar', 'allahabad', 'ranchi', 'jabalpur', 'gwalior', 'vijayawada'];
  if (tier2.includes(c)) return 1.2;
  return 1.0;
}

/**
 * The commercial profile governing an assayer on a given date.
 *
 * This is the same rule FeePolicyService.resolveBaseFee applies (effective on the date, most
 * recent start wins), stated once so the scorers cannot drift from the calculator that
 * actually bills the work. The Cost and Profitability scorers previously disagreed: Cost
 * selected the profile effective on the audit date, Profitability took whichever profile was
 * newest regardless of date. An assayer with a future rate change was therefore scored as
 * cheap by one and expensive by the other in the same recommendation.
 *
 * `profiles` must be ordered by effectiveStartDate DESC, matching both the batched preload and
 * the per-candidate query fallback.
 */
function selectProfileEffectiveOn(
  profiles: AssayerCommercialProfileEntity[],
  onDate: Date,
): AssayerCommercialProfileEntity | null {
  for (const p of profiles) {
    const startsBy = new Date(p.effectiveStartDate) <= onDate;
    const notEnded = !p.effectiveEndDate || new Date(p.effectiveEndDate) >= onDate;
    if (startsBy && notEnded) return p;
  }
  return null;
}

@Injectable()
export class CostScoreCalculator implements ScoreCalculator {
  name = 'cost';

  constructor(
    @InjectRepository(AssayerCommercialProfileEntity)
    private readonly commercialRepository: Repository<AssayerCommercialProfileEntity>,
  ) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    const profiles = context.branchFacts
      ? (context.branchFacts.commercialProfilesByAssayer[assayer.id] ?? [])
      : await this.commercialRepository.find({
          where: { assayerId: assayer.id, isActive: true },
          order: { effectiveStartDate: 'DESC' },
        });

    const activeProfile = selectProfileEffectiveOn(profiles, context.scheduledDate);

    if (!activeProfile) {
      return 50;
    }

    const multiplier = getCityTierMultiplier(context.branch.city);
    const baseFee = (Number(activeProfile.baseFee) || 0) * multiplier;
    return Math.max(0, 100 - (baseFee / 20000) * 100);
  }
}

@Injectable()
export class ClientPreferenceScoreCalculator implements ScoreCalculator {
  name = 'clientPreference';

  async calculate(assayerEntity: AssayerEntity, context: PlanningContext): Promise<number> {
    const assayer = assayerEntity as AssayerWithWorkforceAttributes;
    let score = 50;

    const isPreferred = context.client?.preferredAssayers?.includes(assayer.id);
    if (isPreferred) {
      score = 80;
    }

    const preferences = context.client?.planningPreferences || {};

    // 1. Distance Preferences
    if (context.branch.latitude && context.branch.longitude && assayer.effectiveLatitude && assayer.effectiveLongitude) {
      const distance = calculateHaversineDistance(
        Number(context.branch.latitude),
        Number(context.branch.longitude),
        Number(assayer.effectiveLatitude),
        Number(assayer.effectiveLongitude)
      );

      const minDistance = Number(preferences.minDistanceKm);
      const maxDistance = Number(preferences.maxDistanceKm);

      // Eligibility is decided by DistancePolicyFilter; anything outside the band never
      // reaches a scorer. These penalties remain only as a ranking nudge for the boundary.
      if (!isNaN(minDistance) && distance < minDistance) {
        score -= 40;
      }
      if (!isNaN(maxDistance) && distance > maxDistance) {
        score -= 40;
      }
      if ((isNaN(minDistance) || distance >= minDistance) && (isNaN(maxDistance) || distance <= maxDistance)) {
        score += 10;
      }
    }

    // 2. Skills / Competencies Preferences
    // asArray, not `|| []`: these come from client jsonb the API does not type-check, and a
    // string stored where a list belongs would throw inside `.every()` and 500 the whole
    // recommendations endpoint for that client.
    const asArray = (v: unknown): string[] => (Array.isArray(v) ? v : []);
    const assayerSkills = asArray(assayer.skills);
    const requiredSkills = asArray(preferences.requiredSkills);
    const preferredSkills = asArray(preferences.preferredSkills);

    if (requiredSkills.length > 0) {
      const hasAllRequired = requiredSkills.every((s: string) => 
        assayerSkills.some((as: string) => as.toLowerCase() === s.toLowerCase())
      );
      if (!hasAllRequired) {
        return 0;
      }
      score += 10;
    }

    if (preferredSkills.length > 0) {
      const hasAnyPreferred = preferredSkills.some((s: string) => 
        assayerSkills.some((as: string) => as.toLowerCase() === s.toLowerCase())
      );
      if (hasAnyPreferred) {
        score += 10;
      }
    }

    // 3. Certifications / Courses Preferences
    const assayerCertifications = asArray(assayer.certifications as unknown).map((c: any) => c?.name).filter(Boolean);
    const requiredCerts = asArray(preferences.requiredCertifications);
    const preferredCerts = asArray(preferences.preferredCertifications);

    if (requiredCerts.length > 0) {
      const hasAllRequired = requiredCerts.every((c: string) => 
        assayerCertifications.some((ac: string) => ac.toLowerCase() === c.toLowerCase())
      );
      if (!hasAllRequired) {
        return 0;
      }
      score += 10;
    }

    if (preferredCerts.length > 0) {
      const hasAnyPreferred = preferredCerts.some((c: string) => 
        assayerCertifications.some((ac: string) => ac.toLowerCase() === c.toLowerCase())
      );
      if (hasAnyPreferred) {
        score += 10;
      }
    }

    return Math.max(0, Math.min(100, score));
  }
}

@Injectable()
export class BranchFamiliarityScoreCalculator implements ScoreCalculator {
  name = 'branchFamiliarity';

  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
  ) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    // 1. Branch History score — reward assayers who have previously audited this exact
    // branch (accepted or completed assignments only; the currently-open PENDING offer
    // being replaced is excluded since it isn't ACCEPTED/COMPLETED yet).
    // One grouped count for the whole pool arrives in context; the per-candidate count below
    // remains for standalone use.
    const priorVisits = context.branchFacts
      ? (context.branchFacts.priorVisitsByAssayer[assayer.id] ?? 0)
      : await this.assignmentRepository.count({
          where: {
            assayerId: assayer.id,
            projectBranch: { branchId: context.branch.id },
            status: In([AssignmentStatus.ACCEPTED, AssignmentStatus.COMPLETED]),
            isActive: true,
          },
          relations: ['projectBranch'],
        });
    let score = 50 + Math.min(priorVisits, 3) * 15; // up to +45 for 3+ prior visits to this branch

    // 2. Same-Day Route Grouping Boost (for maximizing auditor utilization in one day)
    if (context.scheduledDate) {
      // Where this assayer is already booked that day. Preloaded for the whole pool in one
      // query; the per-candidate fallback keeps standalone use working. Note the fallback
      // compares the `date` column against a Date carrying a time, which Postgres never
      // matches — the preloaded path uses the date-only key and therefore actually fires.
      const sameDayPoints = context.branchFacts
        ? (context.branchFacts.sameDayBranchPointsByAssayer[assayer.id] ?? [])
        : (
            await this.assignmentRepository.find({
              where: {
                assayerId: assayer.id,
                scheduledDate: context.scheduledDate,
                isActive: true,
              },
              relations: ['projectBranch', 'projectBranch.branch'],
            })
          )
            .map((assign) => assign.projectBranch?.branch)
            .filter((br): br is NonNullable<typeof br> => Boolean(br?.latitude && br?.longitude))
            .map((br) => ({ latitude: Number(br.latitude), longitude: Number(br.longitude) }));

      let hasNearbyGrouping = false;
      for (const point of sameDayPoints) {
        if (context.branch.latitude && context.branch.longitude) {
          const dist = calculateHaversineDistance(
            Number(context.branch.latitude),
            Number(context.branch.longitude),
            point.latitude,
            point.longitude,
          );
          if (dist <= 30) {
            hasNearbyGrouping = true;
            break;
          }
        }
      }

      if (hasNearbyGrouping) {
        score += 45; // Increased boost for close-proximity multi-branch routing to maximize daily utilization
      }
    }

    return Math.min(100, score);
  }
}

@Injectable()
export class SLAComplianceScoreCalculator implements ScoreCalculator {
  name = 'slaCompliance';

  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
  ) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    let score = 80; // Baseline

    // 1. Proximity & Travel Feasibility for SLA
    if (context.branch.latitude && context.branch.longitude && assayer.effectiveLatitude && assayer.effectiveLongitude) {
      const dist = calculateHaversineDistance(
        Number(context.branch.latitude),
        Number(context.branch.longitude),
        Number(assayer.effectiveLatitude),
        Number(assayer.effectiveLongitude)
      );

      if (dist <= 15) {
        score += 20; // High SLA guarantee zone
      } else if (dist > 50) {
        score -= 30; // High risk of travel delays causing SLA breach
      } else if (dist > 30) {
        score -= 15;
      }
    }

    // 2. Same-Day Task Load (Overload increases SLA breach risk)
    if (context.scheduledDate) {
      // Preloaded for the whole pool; see sameDayAcceptedCountByAssayer for why the
      // per-candidate fallback below never actually counted anything.
      const activeSameDayCount = context.branchFacts
        ? (context.branchFacts.sameDayAcceptedCountByAssayer[assayer.id] ?? 0)
        : await this.assignmentRepository.count({
            where: {
              assayerId: assayer.id,
              scheduledDate: context.scheduledDate,
              status: In([AssignmentStatus.ACCEPTED]),
              isActive: true,
            },
          });

      if (activeSameDayCount >= 3) {
        score -= 40; // Heavy schedule risks missing SLA target
      } else if (activeSameDayCount === 2) {
        score -= 20;
      } else if (activeSameDayCount === 0) {
        score += 10; // Unencumbered schedule ensures SLA guarantee
      }
    }

    // 3. Branch Risk Score & Assayer Seniority / SLA Track Record
    const branchRisk = Number(context.branch.riskScore) || 0;
    // See PerformanceScoreCalculator: numeric(3,2) arrives as a string, and `|| 5` would read a
    // real 0.00 as 5.0. Null means UNRATED — no bonus and no penalty; the branch-risk bonus
    // below is for proven reliability, and an unassessed person has not proven anything.
    const rating = assayer.performanceRating == null ? null : Number(assayer.performanceRating);
    const exp = Number(assayer.experienceYears) || 0;

    if (branchRisk >= 7) {
      if (rating !== null && rating >= 4.5 && exp >= 4) {
        score += 15; // High reliability assayer assigned to critical SLA branch
      } else if ((rating !== null && rating < 4.0) || exp < 2) {
        score -= 35; // Risk of SLA breach assigning novice assayer to critical branch
      }
    }

    return Math.max(0, Math.min(100, score));
  }
}

@Injectable()
export class CustomerDensityScoreCalculator implements ScoreCalculator {
  name = 'customerDensity';

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    /**
     * How heavy this branch is, measured in packets — the same figure the day planner sizes a
     * branch's working hours from.
     *
     * This read `context.branch.riskScore` as if it were a customer count and divided it by a
     * weekly assignment capacity: a 0-10 risk rating over a count of assignments, two different
     * units, producing a number that meant nothing. Every branch in the database carries the
     * same risk score, so in practice the scorer returned a near-constant for everybody.
     */
    const packetCount = Number(context.branchFacts?.projectBranch?.packetCount ?? 0);
    if (!Number.isFinite(packetCount) || packetCount <= 0) {
      // Nothing recorded for this cycle — say "no signal" rather than inventing a ranking.
      return 50;
    }

    // Deliberately the platform default, not the 50 that used to sit here: this is the same
    // "how much can this assayer take on" figure every other engine uses, and a second default
    // meant a capacity-less assayer scored as three times roomier here than anywhere else.
    const maxCapacity = assayer.maxWeeklyWorkload || DEFAULT_WEEKLY_CAPACITY;

    // A heavy branch is better given to an assayer with room for it, so the score rises with
    // capacity relative to the load and is capped at 100.
    return Math.max(0, Math.min(100, (maxCapacity / packetCount) * 100));
  }
}

@Injectable()
export class ProfitabilityScoreCalculator implements ScoreCalculator {
  name = 'profitability';

  constructor(
    @InjectRepository(AssayerCommercialProfileEntity)
    private readonly commercialRepository: Repository<AssayerCommercialProfileEntity>,
  ) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    const budget = context.client?.budget ? Number(context.client.budget) : 0;
    if (budget <= 0) return 100; // No budget constraint

    // Same selection as the Cost scorer and FeePolicyService: the profile in force on the
    // audit date. This used to take the newest profile outright, so a rate change dated in the
    // future priced this assayer differently here than everywhere else in the platform.
    const profiles = context.branchFacts
      ? (context.branchFacts.commercialProfilesByAssayer[assayer.id] ?? [])
      : await this.commercialRepository.find({
          where: { assayerId: assayer.id, isActive: true },
          order: { effectiveStartDate: 'DESC' },
        });
    const profile = selectProfileEffectiveOn(profiles, context.scheduledDate);

    if (!profile) return 50;

    const totalCost = Number(profile.baseFee) + Number(profile.dailyRate);
    if (totalCost > budget) {
      // Score drops linearly based on budget overflow
      return Math.max(0, 50 - ((totalCost - budget) / budget) * 50);
    }
    // Margin incentive: higher budget margin = higher score
    return Math.min(100, 50 + ((budget - totalCost) / budget) * 50);
  }
}

@Injectable()
export class RiskScoreCalculator implements ScoreCalculator {
  name = 'riskScore';

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    /**
     * `riskScore` is on a 0–10 scale — `riskScoreFromCategory` in the importer writes
     * LOW 2 / MEDIUM 4 / HIGH 7 / CRITICAL 9, and the SLA scorer above and the planning map both
     * read "high" as >= 7.
     *
     * This used to test `risk < 50`, a threshold from a 0–100 scale the data never used. Every
     * branch scored below 50 by definition, so this returned 100 for everybody and the one
     * calculator named after risk never distinguished a critical branch from a trivial one.
     * The penalty was `100 - risk` on the same wrong scale — a 9 would have cost one point.
     */
    const risk = Number(context.branch.riskScore) || 0;
    if (risk < 7) return 100; // Not a high-risk branch: anyone qualified may take it.

    // High risk branch requires senior experience (years >= 5) & high rating (>= 4.5).
    // Same rule as the other two rating readers: null is UNRATED, not excellent. This gate
    // decides who is trusted with a high-risk branch, and "nobody has assessed them" is not
    // the same answer as "they were assessed and are excellent".
    const exp = Number(assayer.experienceYears) || 0;
    const rating = assayer.performanceRating == null ? null : Number(assayer.performanceRating);

    if (exp >= 5 && rating !== null && rating >= 4.5) {
      return 100;
    }
    // Ten points off per risk point: HIGH (7) costs a junior 70, CRITICAL (9) costs 90 — a steep
    // enough cliff that the senior candidate wins whenever one exists, without zeroing the only
    // candidate when nobody senior is free.
    return Math.max(0, 100 - risk * 10);
  }
}

/**
 * What the people who work with this assayer have said about them, as a number.
 *
 * ## What it reads
 *
 * Staff remarks (modules/assayer-remarks) rated −2…+2, from the last 365 days, each weighted
 * `exp(-ageDays / 90)` so last week's observation counts for e-fold more than one from three
 * months ago. Score = `50 + 25 × weighted mean`: nothing said → 50 (neutral, the engine's usual
 * "no signal"), everything glowing → 100, everything damning → 0.
 *
 * ## Why it cannot exclude anyone
 *
 * The mean is bounded to [-2, +2] by the DB CHECK on `rating`, so the score is bounded to
 * [0, 100] by arithmetic, not by a clamp that could be forgotten. At its default weight (0.06)
 * the worst possible remark history costs a candidate 6 points of a 100-point total — enough to
 * lose a close call to a peer with a clean record, nowhere near enough to fall off the list. That
 * is deliberate: a remark is one person's view on one day, and the operator, not the scorer, is
 * the one who should decide it disqualifies someone. The exclusion filters are untouched.
 *
 * ## Rejected alternatives
 *
 *  - Adjust `assayer.performanceRating` from remarks (the older path did this into
 *    `averageRating`, which nothing read). It hides the signal inside another number, has no
 *    recency, and cannot be explained on the card as "3 remarks, avg −0.7".
 *  - A hard rule "any −2 in 90 days → excluded". Turns a single bad day into invisibility, with
 *    no one accountable for the exclusion. Explicitly out of scope.
 *  - Per-category weights (CONDUCT counts double, say). Nobody could agree the numbers, and a
 *    scheme like that is what makes people stop writing remarks. The category is for the reader.
 *
 * ## Where the data comes from
 *
 * `context.branchFacts.remarksByAssayer`, one query for the pool. The per-candidate call below
 * exists only for standalone use of the calculator; recommend() never takes that path.
 */
@Injectable()
export class RemarksScoreCalculator implements ScoreCalculator {
  name = 'remarksScore';

  constructor(private readonly remarksService: AssayerRemarksService) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    return remarksScoreFrom(await this.summaryFor(assayer, context));
  }

  /** The same summary the card shows, so what ops reads and what the ranking used agree. */
  async summaryFor(assayer: AssayerEntity, context: PlanningContext): Promise<RemarkSummary> {
    const shared = context?.branchFacts?.remarksByAssayer;
    if (shared) return summariseRemarks(shared[assayer.id] ?? []);
    const loaded: Record<string, RemarkForScoring[]> = await this.remarksService
      .loadScoringWindow([assayer.id])
      .catch(() => ({}));
    return summariseRemarks(loaded[assayer.id] ?? []);
  }
}

/**
 * Rotation fairness: prefer, gently, whoever has been offered the least work lately.
 *
 * ## The problem it answers
 *
 * Every other dimension rewards being good — near, fast, accepted, clean paperwork — and the
 * best assayer near a cluster of branches wins all of them, every cycle. That is correct on
 * merit and bad for the business: it makes the plan brittle (one person's leave empties a
 * region), it starves newer assayers of the work that would make them good, and it is the thing
 * the workforce complains about most. Nothing in the engine pushed the other way.
 *
 * ## What it does
 *
 * Offers in the last 30 days (assignments created, any status, live rows), per candidate, from
 * one grouped count. Score = `100 × (1 − min(1, offers / cap))`, cap = platform setting
 * `planning.fairnessOfferCap` (default 8). 0 offers → 100, cap or more → 0.
 *
 * ## Why it is a nudge and not a quota
 *
 * At weight 0.04 the whole dimension is worth 4 points. A candidate who is 5 points better on
 * merit still wins against someone who has had nothing all month; two candidates within a point
 * of each other now go to the one who has been sitting idle instead of always the same one. It
 * changes ties and near-ties, which is exactly the set of decisions where "spread it around"
 * costs nothing. It never removes a candidate, never caps anyone's work, and an operator can
 * still pick whoever they like from the list. Counting offers rather than acceptances is
 * deliberate: someone who was offered eight jobs and declined them has still had their turn.
 *
 * ## Rejected alternatives
 *
 *  - A hard rotation ("no more than N per month"). A quota on a workforce that is partly
 *    part-time and partly regional cannot be one number, and the operator would end up
 *    overriding it daily.
 *  - Round-robin within a cluster. Ignores merit entirely, which is the opposite mistake.
 *  - Reading `workload` (committed jobs) instead of offers. Workload is about capacity right now;
 *    fairness is about who has had a chance recently. Someone with a full week is scored down by
 *    workload already; someone who had a busy fortnight and is free now is exactly who this
 *    dimension should still count against, a little.
 */
@Injectable()
export class FairnessScoreCalculator implements ScoreCalculator {
  name = 'fairness';

  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
  ) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    const cap = context?.branchFacts?.fairnessOfferCap ?? DEFAULT_FAIRNESS_OFFER_CAP;
    const shared = context?.branchFacts?.recentOffersByAssayer;
    if (shared) return fairnessScoreFrom(shared[assayer.id] ?? 0, cap);

    // Standalone fallback only; recommend() supplies the grouped count for the whole pool.
    const since = new Date(Date.now() - FAIRNESS_OFFER_WINDOW_DAYS * 86_400_000);
    const offers = await this.assignmentRepository
      .createQueryBuilder('a')
      .where('a.isActive = true')
      .andWhere('a.assayerId = :id', { id: assayer.id })
      .andWhere('a.createdAt >= :since', { since })
      .getCount()
      .catch(() => 0);
    return fairnessScoreFrom(offers, cap);
  }
}

/** Per-client data a batch of recommendation runs can share. */
export interface RecommendationPreload {
  client: ClientEntity | null;
  assayers: AssayerEntity[];
}

export interface RecommendOptions {
  /** See PlanningContext.relaxAvailability. */
  relaxAvailability?: boolean;
  /**
   * How far from the branch to look for candidates, in km. The operator's own choice.
   *
   * Without this the search area was a fixed 200 km that nothing on screen mentioned, while the
   * planning map let an operator set their own radius and drew every assayer inside it. Setting
   * 350 km therefore produced pins the engine had already discarded — assayers who were free,
   * qualified and plainly visible, with no candidate row and no way to reach one.
   *
   * Bounded by MAX_SEARCH_RADIUS_KM. The bound is not a policy about how far someone may
   * travel — the distance filters and the client's own serviceability radius decide that — it
   * is only there to stop one request scanning a national workforce.
   */
  searchRadiusKm?: number;
}

/**
 * Coarse geographic pre-filter for the candidate pool.
 *
 * Before any scoring, the candidate set is narrowed to assayers whose registered home is within
 * this many kilometres of the branch (plus anyone sharing a live location — see
 * findNearbyActiveAssayerIds). This bounds an otherwise O(branches × all-assayers) pass: every
 * branch previously scored, routed, and ran seven eligibility filters against every active
 * assayer in the country, so at national headcount the cost of one recommendation grew with total
 * workforce size rather than with anything about the branch.
 *
 * It is deliberately generous — far wider than the ~50 km serviceability radius the day planner
 * and the distance scorers work in — because this is only a "could this person conceivably be
 * considered?" bound, not a serviceability decision. Distance still ranks candidates
 * (DistanceScoreCalculator / TravelTimeScoreCalculator) and the client's min-distance floor still
 * excludes them (DistancePolicyFilter); this only keeps the pool from spanning the whole country.
 * The effective radius is max(this, the client's configured defaultRadius), so a client that
 * widens its serviceability radius past this is never pruned inside it.
 *
 * Additive and reversible: if the branch has no coordinates, nobody falls in range, or the
 * spatial query fails, the engine falls back to the full active pool exactly as before, so
 * coverage is never silently reduced.
 */
const CANDIDATE_PREFILTER_RADIUS_KM = 200;

/**
 * How far out to bother naming the assayers the pre-filter dropped.
 *
 * Comfortably wider than the pre-filter itself, and wider than the planning map's own search
 * radius, so an operator who widens the map and asks "why isn't that one a candidate?" gets an
 * answer instead of silence.
 */
const PRUNED_EXPLANATION_RADIUS_KM = 500;

/** At most this many, nearest first — an explanation, not a national roster dump. */
const MAX_PRUNED_REPORTED = 10;

/**
 * The widest search an operator may ask for in one request.
 *
 * India is roughly 3,000 km corner to corner, so this is generous enough that no legitimate
 * "look further afield" is refused, while still stopping a single recommendation from scoring,
 * routing and rule-checking every assayer in the country.
 */
const MAX_SEARCH_RADIUS_KM = 1000;

@Injectable()
export class RecommendationEngine {
  private static readonly logger = new Logger(RecommendationEngine.name);
  private filters: CandidateFilter[] = [];
  private calculators: ScoreCalculator[] = [];

  constructor(
    private readonly deployabilityFilter: DeployabilityFilter,
    private readonly availabilityFilter: AvailabilityFilter,
    private readonly consecutiveBranchAuditFilter: ConsecutiveBranchAuditFilter,
    private readonly clientRestrictionFilter: ClientRestrictionFilter,
    private readonly clientEligibilityFilter: ClientEligibilityFilter,
    private readonly ruleEngineEligibilityFilter: RuleEngineEligibilityFilter,
    private readonly requiredSkillsFilter: RequiredSkillsFilter,
    private readonly distancePolicyFilter: DistancePolicyFilter,
    private readonly distanceCalculator: DistanceScoreCalculator,
    private readonly travelTimeCalculator: TravelTimeScoreCalculator,
    private readonly workloadCalculator: WorkloadScoreCalculator,
    private readonly performanceCalculator: PerformanceScoreCalculator,
    private readonly rejectionAcceptanceCalculator: RejectionAcceptanceScoreCalculator,
    private readonly deliverySpeedCalculator: DeliverySpeedScoreCalculator,
    private readonly queryVolumeCalculator: QueryVolumeScoreCalculator,
    private readonly experienceCalculator: ExperienceScoreCalculator,
    private readonly costCalculator: CostScoreCalculator,
    private readonly clientPreferenceCalculator: ClientPreferenceScoreCalculator,
    private readonly branchFamiliarityCalculator: BranchFamiliarityScoreCalculator,
    private readonly slaComplianceCalculator: SLAComplianceScoreCalculator,
    private readonly customerDensityCalculator: CustomerDensityScoreCalculator,
    private readonly profitabilityCalculator: ProfitabilityScoreCalculator,
    private readonly riskCalculator: RiskScoreCalculator,
    private readonly remarksCalculator: RemarksScoreCalculator,
    private readonly fairnessCalculator: FairnessScoreCalculator,
    private readonly configResolver: ConfigurationResolver,
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    @InjectRepository(ClientEntity)
    private readonly clientRepository: Repository<ClientEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly constraintEvaluator: ConstraintEvaluator,
    // Used only to resolve the per-recommendation shared facts, so filters and scorers no
    // longer each query for these per candidate.
    @InjectRepository(ProjectBranchEntity)
    private readonly engineProjectBranchRepository: Repository<ProjectBranchEntity>,
    @InjectRepository(AssayerCommercialProfileEntity)
    private readonly commercialRepositoryForFacts: Repository<AssayerCommercialProfileEntity>,
    @InjectRepository(ValidationQueryEntity)
    private readonly queryRepositoryForFacts: Repository<ValidationQueryEntity>,
    /**
     * Used only to preload this branch's rule set once per recommendation — the eligibility
     * filter then evaluates every candidate against that same list instead of re-reading it.
     */
    private readonly ruleEngine: RuleEngine,
    private readonly engineRoutingService: RoutingService,
    private readonly assayerService: AssayerService,
    /**
     * Two more per-recommendation facts: the pool's recent staff remarks (one query through the
     * remarks module, which owns that table) and the fairness offer cap (one settings read).
     */
    private readonly remarksServiceForFacts: AssayerRemarksService,
    private readonly platformSettings: PlatformSettingsService,
  ) {
    this.filters.push(
      // First: "can this person be sent anywhere at all?" — see DeployabilityFilter.
      this.deployabilityFilter,
      this.availabilityFilter,
      this.consecutiveBranchAuditFilter,
      this.clientRestrictionFilter,
      this.clientEligibilityFilter,
      this.ruleEngineEligibilityFilter,
      this.requiredSkillsFilter,
      this.distancePolicyFilter,
    );

    this.calculators.push(
      this.distanceCalculator,
      this.travelTimeCalculator,
      this.workloadCalculator,
      this.performanceCalculator,
      this.rejectionAcceptanceCalculator,
      this.deliverySpeedCalculator,
      this.queryVolumeCalculator,
      this.experienceCalculator,
      this.costCalculator,
      this.clientPreferenceCalculator,
      this.branchFamiliarityCalculator,
      this.slaComplianceCalculator,
      this.customerDensityCalculator,
      this.profitabilityCalculator,
      this.riskCalculator,
      // What staff have said about them, and whether they have had a fair share of offers
      // lately — see the two classes for why each is bounded and gentle.
      this.remarksCalculator,
      this.fairnessCalculator,
    );

    // A calculator with no configured weight still runs — it just contributes nothing, which
    // is invisible in the output. Six shipped that way. Surface it loudly instead.
    const unweighted = ConfigurationResolver.assertWeightsCoverAllCalculators(
      this.calculators.map((c) => c.name),
    );
    if (unweighted.length > 0) {
      RecommendationEngine.logger.error(
        `Scoring calculators registered with no configured weight — they will run on every ` +
          `recommendation and contribute nothing to the ranking: ${unweighted.join(', ')}. ` +
          `Add them to DEFAULT_RECOMMENDATION_CONFIG.weights.`,
      );
    }
  }

  /**
   * Load the parts of a recommendation run that do not vary between branches of the same
   * client, so a batch caller can pay for them once instead of once per branch.
   *
   * Coverage planning scores 31 clusters for a single project, and each `recommend()` call
   * independently re-fetched the same client, re-loaded every active assayer, and re-ran
   * workforce hydration over all of them — 31 times. That is most of why the coverage-plan
   * endpoint took over four seconds on 72 branches, and it scales with branch count, so a
   * national rollout would push it past any reasonable timeout.
   */
  async preloadContext(clientId?: string | null): Promise<RecommendationPreload> {
    const client = clientId
      ? await this.clientRepository.findOne({ where: { id: clientId, isActive: true } })
      : null;

    /**
     * Deployable workforce only — deliberately narrower than the interactive path, which also
     * pulls in still-onboarding profiles so it can explain them.
     *
     * A coverage plan is a proposal to actually staff a project. Listing people who cannot be
     * dispatched would either inflate the coverage figure quoted to the client or bury the plan
     * in exclusions nobody asked for. The interactive candidate list is answering a different
     * question — "why isn't this person here?" — and that is where the explanation belongs.
     */
    const assayers = await this.assayerRepository.find({
      where: { isActive: true, status: AssayerStatus.ACTIVE },
    });
    await this.assayerService.hydrateAllWorkforceAttributes(assayers);

    return { client, assayers };
  }

  /**
   * IDs of the active assayers worth scoring for a given branch: those whose registered home is
   * within `radiusKm` of the branch, plus any assayer sharing a live location. Returns null to
   * signal "no usable pre-filter" — the branch has no coordinates, nobody fell in range, or the
   * spatial query failed — in which case the caller keeps the full active pool exactly as before,
   * so this can only ever shrink the pool, never silently empty it.
   *
   * Home coordinates (latitude/longitude) are used deliberately, matching the conflict-of-interest
   * floor in DistancePolicyFilter: a candidate pool that moved with someone's phone would not be a
   * stable notion of "near this branch". Live-enabled assayers are kept unconditionally so an
   * opted-in mobile auditor whose home is far away is never dropped by a stale home coordinate —
   * their effective (live) position is what the scorers actually route from.
   *
   * Assayers with NO coordinates are kept too. Geocoding an address can fail — `AssayerService`
   * saves the profile without a location and logs it — and this predicate dropped exactly those
   * people whenever anyone else was in range, so a newly added assayer whose address did not
   * resolve was doubly invisible: absent from the candidate list and absent from the excluded
   * list that explains it. An unknown location is a data gap to surface, not a disqualification.
   *
   * Bounded with `ST_DWithin` against the stored `location` geometry, falling back to the lat/long
   * pair for any row whose geometry was never written.
   *
   * It used to compute `ST_DistanceSphere(ST_MakePoint(a.longitude, a.latitude), …)` inline, which
   * measures the exact distance to *every* assayer on *every* planning request and cannot use the
   * GiST index the table already carries — the point being compared did not exist until the query
   * ran. Over a 5,000-strong workforce that was a 53 ms sequential scan on the most frequently hit
   * planning path; `ST_DWithin` bounds the search first and comes in under a millisecond.
   *
   * `use_spheroid = false` is not an optimisation, it is what keeps the answer identical.
   * `ST_DistanceSphere` measures on a sphere and geography defaults to the WGS84 spheroid, so the
   * default would quietly move the boundary — measured on a 5,000-assayer set, 322 candidates
   * instead of 321. Passing false selects the same spherical maths, and the same candidates.
   */
  private async findNearbyActiveAssayerIds(
    branch: BranchEntity,
    radiusKm: number,
    /**
     * Filled with the assayers this pre-filter pruned, nearest first.
     *
     * The pre-filter runs before every eligibility rule, so anyone it drops produces no
     * exclusion reason at all — they are simply absent. That silently defeats the excluded-
     * candidates panel, whose entire job is to answer "why isn't this person in the list?".
     *
     * It shows up as a direct contradiction on screen: the planning map draws assayers by the
     * operator's own search radius (350 km, say), while this prunes at 200 km, so five pins
     * appear around a branch whose candidate list is empty and whose "excluded" panel is empty
     * too. Reporting them as a distance exclusion turns that into a sentence somebody can act on.
     */
    prunedOut?: Array<{ id: string; displayName: string; distanceKm: number }>,
  ): Promise<Set<string> | null> {
    if (branch.latitude == null || branch.longitude == null) return null;

    const radiusMeters = radiusKm * 1000;
    const rows: Array<{ id: string }> | null = await this.assayerRepository
      .query(
        `SELECT a.id AS id
           FROM assayers a
          WHERE a.is_active = true
            -- ::text on both sides. Both columns are Postgres enum types, and comparing an
            -- enum to a text[] parameter is a hard error ("operator does not exist"), not a
            -- coercion. It would have been invisible: the caller catches and falls back to the
            -- unbounded pool, so the pre-filter would simply have stopped working.
            AND (a.status::text = $1 OR a.lifecycle_status::text = ANY($5))
            AND (
              a.is_live_enabled = true
              -- Unknown position — kept, so it reaches the excluded panel with a reason rather
              -- than vanishing. The location geometry and latitude/longitude are written by
              -- resolveCoordinates, so this is the same set the lat/long null-check selected;
              -- were a row ever to carry coordinates without the geometry, keeping it is the
              -- safe direction: an extra candidate is visible and explainable, a dropped one
              -- is neither.
              OR a.location IS NULL
              -- Tested against the bare column so it matches the functional index on
              -- ("location"::geography); wrapping the column in COALESCE or anything else makes
              -- the expression unrecognisable to the planner and the index unusable.
              OR ST_DWithin(a.location::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4, false)
            )`,
        [
          AssayerStatus.ACTIVE,
          Number(branch.longitude),
          Number(branch.latitude),
          radiusMeters,
          // Still-onboarding profiles are kept in the pool so the engine can say why they are
          // not selectable — see ONBOARDING_LIFECYCLE_STATES.
          ONBOARDING_LIFECYCLE_STATES,
        ],
      )
      .catch((err) => {
        // Falling back is right — a broken pre-filter must not empty the candidate list — but
        // doing it silently is not. A malformed predicate here (an enum compared to text[], a
        // renamed column) degrades every recommendation to a national scan and shows no symptom
        // at all except latency, which is exactly the kind of failure nobody goes looking for.
        RecommendationEngine.logger.error(
          `Candidate pre-filter query failed for branch ${branch.id}; falling back to the full ` +
            `active pool. Recommendations are still correct but unbounded. ${err?.message ?? err}`,
        );
        return null;
      });

    if (!rows) return null; // query failed — fall back to the full pool
    if (rows.length === 0) return null; // nobody in range — fall back rather than return empty
    const kept = new Set(rows.map((r) => r.id));

    /**
     * Who was dropped, and how far away they are.
     *
     * Bounded twice over: only assayers inside `PRUNED_EXPLANATION_RADIUS_KM` are looked up, and
     * only the nearest few are reported. The point is to explain the pins an operator can
     * actually see next to this branch, not to enumerate a national workforce — a list of every
     * assayer in the country would bury the reasons that matter under noise.
     */
    if (prunedOut) {
      const pruned: Array<{ id: string; displayName: string; distanceKm: string }> = await this.assayerRepository
        .query(
          `SELECT a.id, a.display_name AS "displayName",
                  ST_DistanceSphere(
                    ST_SetSRID(ST_MakePoint(a.longitude, a.latitude), 4326),
                    ST_SetSRID(ST_MakePoint($1, $2), 4326)
                  ) / 1000 AS "distanceKm"
             FROM assayers a
            WHERE a.is_active = true
              AND (a.status::text = $3 OR a.lifecycle_status::text = ANY($4))
              AND a.latitude IS NOT NULL AND a.longitude IS NOT NULL
              AND NOT (a.id = ANY($5))
              AND ST_DistanceSphere(
                    ST_SetSRID(ST_MakePoint(a.longitude, a.latitude), 4326),
                    ST_SetSRID(ST_MakePoint($1, $2), 4326)
                  ) <= $6
            ORDER BY "distanceKm" ASC
            LIMIT ${MAX_PRUNED_REPORTED}`,
          [
            Number(branch.longitude),
            Number(branch.latitude),
            AssayerStatus.ACTIVE,
            ONBOARDING_LIFECYCLE_STATES,
            [...kept],
            PRUNED_EXPLANATION_RADIUS_KM * 1000,
          ],
        )
        .catch(() => []);

      for (const p of pruned) {
        prunedOut.push({ id: p.id, displayName: p.displayName, distanceKm: Number(p.distanceKm) });
      }
    }

    return kept;
  }

  /**
   * The date clash a relaxed candidate still carries, phrased for the operator, or null when
   * they are genuinely free that day. Reads only facts already resolved for the whole pool.
   */
  private describeDateConflict(assayer: AssayerEntity, context: PlanningContext): string | null {
    const booking = context.branchFacts?.doubleBookedByAssayer[assayer.id];
    if (booking) return `Already booked that day on ${booking}.`;

    const dateKey = businessDateKey(context.scheduledDate);
    const leave = ((assayer as any).leaves ?? []).find(
      (l: { startDate?: string; endDate?: string }) =>
        l?.startDate && l?.endDate && l.startDate <= dateKey && dateKey <= l.endDate,
    );
    if (leave) return `On leave ${leave.startDate} to ${leave.endDate}.`;

    return null;
  }

  async recommend(
    branch: BranchEntity,
    scheduledDate: Date,
    weights: Record<string, number> = {},
    /**
     * Supplied by batch callers that already hold the client and hydrated assayer list.
     * Omitted, this method behaves exactly as before and loads them itself.
     */
    preloaded?: RecommendationPreload,
    /** See PlanningContext.relaxAvailability. */
    options?: RecommendOptions,
  ) {
    const client = preloaded
      ? preloaded.client
      : branch.clientId
      ? await this.clientRepository.findOne({ where: { id: branch.clientId, isActive: true } })
      : null;

    const resolvedConfig = this.configResolver.resolveRecommendationConfig(client, { weights });

    const context: PlanningContext = {
      branch,
      client,
      scheduledDate,
      weights: resolvedConfig.weights,
      relaxAvailability: options?.relaxAvailability === true,
    };

    // Bound the candidate pool by geography before any scoring — see CANDIDATE_PREFILTER_RADIUS_KM.
    // The effective radius never drops below the client's configured serviceability radius, so the
    // pre-filter can only ever be wider than what scoring already tolerates. `nearbyIds` is null
    // when there is no usable pre-filter (no branch coordinates, nobody in range, or the query
    // failed), in which case the full active pool is kept exactly as before.
    /**
     * The operator's radius wins when they set one; otherwise the default floor.
     *
     * Still a `max` against the client's configured serviceability radius, so a client who
     * services 400 km is never searched at 200 — but an explicit request now widens it too,
     * which is what makes the map's radius control and the candidate list agree.
     */
    const requestedRadius = Number(options?.searchRadiusKm);
    const prefilterRadiusKm = Math.min(
      MAX_SEARCH_RADIUS_KM,
      Math.max(
        Number.isFinite(requestedRadius) && requestedRadius > 0 ? requestedRadius : CANDIDATE_PREFILTER_RADIUS_KM,
        Number(resolvedConfig.defaultRadius) || 0,
      ),
    );
    // Collected so the pre-filter can explain itself rather than dropping people silently —
    // see the note on findNearbyActiveAssayerIds' `prunedOut`.
    const prunedByDistance: Array<{ id: string; displayName: string; distanceKm: number }> = [];
    const nearbyIds = await this.findNearbyActiveAssayerIds(branch, prefilterRadiusKm, prunedByDistance);

    // Reused from the preload when a batch caller supplied one; hydration is idempotent and
    // the scorers only read these, so sharing one list across branches is safe.
    let assayers = preloaded?.assayers;
    if (assayers) {
      // Batch path: the preloaded pool is already loaded and hydrated. Narrow it in memory to
      // the branch's neighbourhood — and when nobody is in range, the honest answer is an EMPTY
      // list, not the whole national pool. The old "safe fallback" quietly scored all 500+
      // active assayers for that one branch, and a coverage plan could then deploy someone
      // 1,500 km away with no distance exclusion recorded anywhere (everyone was "kept", so the
      // pruned list was empty). An uncovered branch is a result the planner already knows how
      // to surface; a silently nationwide search is not.
      if (nearbyIds) {
        assayers = assayers.filter((a) => nearbyIds.has(a.id));
      }
    } else {
      // Non-batch path: load only the in-range assayers when we have a pre-filter, otherwise the
      // full active pool. The isActive/status predicate is identical to before in both branches;
      // `nearbyIds` was itself resolved under the same predicate, so the set is unchanged apart
      // from the geographic bound.
      // The status predicate matches findNearbyActiveAssayerIds: assignable today, OR still
      // working through onboarding so the exclusion list can explain them.
      const deployableOrOnboarding = (extra: Record<string, unknown>) => [
        { ...extra, isActive: true, status: AssayerStatus.ACTIVE },
        { ...extra, isActive: true, lifecycleStatus: In(ONBOARDING_LIFECYCLE_STATES) },
      ];
      assayers = nearbyIds
        ? await this.assayerRepository.find({ where: deployableOrOnboarding({ id: In([...nearbyIds]) }) })
        : await this.assayerRepository.find({ where: deployableOrOnboarding({}) });
      await this.assayerService.hydrateAllWorkforceAttributes(assayers);
    }

    /**
     * Resolve, once, the two things several filters and scorers were each querying per
     * candidate: this branch's most recent assignment (identical for everyone) and the
     * committed workload of every assayer in the pool (one grouped count instead of N).
     *
     * With a national workforce the per-candidate versions made the cost of a single
     * recommendation grow with total headcount rather than with anything about the branch.
     */
    // Monday of the week being planned, for the weekly workload window below.
    const workloadWeekAnchor = scheduledDate ?? new Date();
    const workloadWeekStart = new Date(workloadWeekAnchor);
    workloadWeekStart.setDate(workloadWeekAnchor.getDate() - ((workloadWeekAnchor.getDay() + 6) % 7));

    const [lastAssignment, workloadRows, projectBranchRow] = await Promise.all([
      this.assignmentRepository.findOne({
        where: { projectBranch: { branchId: branch.id }, isActive: true },
        order: { createdAt: 'DESC' },
        relations: ['projectBranch'],
      }).catch(() => null),
      this.assignmentRepository
        .createQueryBuilder('a')
        .select('a.assayerId', 'assayerId')
        .addSelect('COUNT(*)::int', 'count')
        .where('a.isActive = true')
        .andWhere('a.status IN (:...statuses)', {
          statuses: COMMITTED_ASSIGNMENT_STATUSES,
        })
        // Windowed to the week being planned: this count is divided by a WEEKLY cap (and feeds
        // the CAPACITY rule, whose action is BLOCK), so an unwindowed count of every open
        // commitment ever — including rows stuck in ACCEPTED from months past — permanently
        // zeroed someone's workload score and could bar them from the list with an empty diary.
        // Scheduled-date-less rows still count: undated work is presumed to be in play now.
        .andWhere(
          "(a.scheduledDate IS NULL OR (a.scheduledDate >= :weekStart AND a.scheduledDate < CAST(:weekStart AS date) + INTERVAL '7 days'))",
          { weekStart: businessDateKey(workloadWeekStart) },
        )
        .andWhere('a.assayerId IN (:...ids)', { ids: assayers.map((a) => a.id) })
        .groupBy('a.assayerId')
        .getRawMany()
        .catch(() => []),
      this.engineProjectBranchRepository.findOne({
        where: { branchId: branch.id, isActive: true },
        relations: ['project'],
      }).catch(() => null),
    ]);

    /**
     * One routing request for the whole pool, not one per candidate.
     *
     * The distance and travel-time scorers each routed the same origin/destination pair, so a
     * pool of N candidates once produced 2N calls to the routing provider — the single most
     * expensive operation here, since it reaches an external road router. Sharing one result
     * per candidate halved that; this batches the rest. `calculateDistances` sends the branch
     * and every candidate coordinate in one `/table` request (chunked past ~100 coordinates),
     * answers from the 30-day route cache first, and routes each distinct coordinate once —
     * which matters on this database, where most assayers sit on a city centroid. Measured on
     * the dev database (2026-08-17, PUNE CAMP against every geo-located assayer): 27
     * candidates, 25 distinct points, one HTTP request in 951 ms on a cold cache and zero
     * requests in 1 ms on a warm one, where the old code made 27 requests every time; and
     * `/table` returns the same figures as `/route` to the metre.
     *
     * The provider never rejects (a dead router yields a labelled great-circle estimate), so a
     * failed batch here means a programming fault. Rather than blank every candidate's distance
     * for it, the old per-candidate lookups run instead — a slower answer, not a missing one.
     * That path is also what a routing double that only stubs `calculateRoute` exercises.
     */
    const routeByAssayer: Record<string, { distanceKm: number; durationMinutes: number; source: RouteSource }> = {};
    if (branch.latitude && branch.longitude) {
      const origin = { latitude: Number(branch.latitude), longitude: Number(branch.longitude) };
      const destinations = assayers
        .filter((a) => a.effectiveLatitude && a.effectiveLongitude)
        .map((a) => ({ id: a.id, latitude: Number(a.effectiveLatitude), longitude: Number(a.effectiveLongitude) }));
      const keep = (id: string, route: { distanceKm: number; durationMinutes: number; source?: RouteSource } | null | undefined) => {
        if (!route) return;
        routeByAssayer[id] = {
          distanceKm: route.distanceKm,
          durationMinutes: route.durationMinutes,
          // A route with no label came from something older than the labelled provider; the
          // only honest thing to call it is an estimate.
          source: route.source ?? 'ESTIMATE',
        };
      };

      let batched: Record<string, { distanceKm: number; durationMinutes: number; source?: RouteSource }> | null = null;
      if (destinations.length > 0) {
        try {
          batched = await this.engineRoutingService.calculateDistances(origin, destinations, 'driving');
        } catch {
          batched = null;
        }
      }

      if (batched) {
        for (const d of destinations) keep(d.id, batched[d.id]);
      } else {
        const routed = await Promise.all(
          destinations.map(async (d) => {
            const route = await this.engineRoutingService.calculateRoute(origin, d).catch(() => null);
            return [d.id, route] as const;
          }),
        );
        for (const [id, route] of routed) keep(id, route);
      }
    }

    /**
     * Three more sets of per-candidate lookups collapsed into one query each.
     *
     * Cost and profitability both read the commercial profile table per assayer; rejection
     * rate issued two counts per assayer; query volume issued one. Across a pool of N that is
     * 4N round trips producing values that a single grouped query returns in one.
     */
    const assayerIds = assayers.map((a) => a.id);
    const [
      profileRows,
      queryRows,
      totalRows,
      acceptedRows,
      doubleBookedRows,
      completedRows,
      rules,
      priorVisitRows,
      sameDayRows,
      remarksByAssayer,
      recentOfferRows,
      fairnessOfferCap,
    ] = await Promise.all([
      assayerIds.length
        ? this.commercialRepositoryForFacts.find({
            where: { assayerId: In(assayerIds), isActive: true },
            order: { effectiveStartDate: 'DESC' },
          }).catch(() => [])
        : Promise.resolve([]),
      assayerIds.length
        ? this.queryRepositoryForFacts
            .createQueryBuilder('q')
            .select('q.assayerId', 'assayerId')
            .addSelect('COUNT(*)::int', 'count')
            .where('q.isActive = true')
            .andWhere('q.assayerId IN (:...ids)', { ids: assayerIds })
            .groupBy('q.assayerId')
            .getRawMany()
            .catch(() => [])
        : Promise.resolve([]),
      assayerIds.length
        ? this.assignmentRepository
            .createQueryBuilder('a')
            .select('a.assayerId', 'assayerId')
            .addSelect('COUNT(*)::int', 'count')
            .where('a.isActive = true')
            .andWhere('a.assayerId IN (:...ids)', { ids: assayerIds })
            .groupBy('a.assayerId')
            .getRawMany()
            .catch(() => [])
        : Promise.resolve([]),
      assayerIds.length
        ? this.assignmentRepository
            .createQueryBuilder('a')
            .select('a.assayerId', 'assayerId')
            .addSelect('COUNT(*)::int', 'count')
            .where('a.isActive = true')
            .andWhere('a.status IN (:...statuses)', {
              statuses: [AssignmentStatus.ACCEPTED, AssignmentStatus.COMPLETED],
            })
            .andWhere('a.assayerId IN (:...ids)', { ids: assayerIds })
            .groupBy('a.assayerId')
            .getRawMany()
            .catch(() => [])
        : Promise.resolve([]),
      // Who is already committed on this date. One query answers it for the whole pool; it
      // was previously a findOne per candidate asking the same date question.
      assayerIds.length
        ? this.assignmentRepository.find({
            where: {
              assayerId: In(assayerIds),
              // The column is `date`; comparing it to a full Date-with-time is always false in
              // Postgres (a mid-afternoon `new Date()` never equals a midnight date), which
              // silently emptied this set and defeated the double-booking guard. Match on the
              // date-only business key so it actually fires.
              scheduledDate: businessDateKey(scheduledDate) as any,
              // Same set as ConstraintEvaluator.checkDoubleBooking — a day is committed from
              // acceptance through completion, so a checked-in assayer is not offered again.
              status: In(COMMITTED_ASSIGNMENT_STATUSES),
              isActive: true,
            },
            select: ['assayerId', 'assignmentNumber'] as any,
          }).catch(() => [])
        : Promise.resolve([]),
      // Completed history for the delivery-speed score.
      assayerIds.length
        ? this.assignmentRepository.find({
            where: {
              assayerId: In(assayerIds),
              status: AssignmentStatus.COMPLETED,
              isActive: true,
            },
            select: ['assayerId', 'completionDate', 'createdAt'] as any,
            order: { createdAt: 'DESC' },
          }).catch(() => [])
        : Promise.resolve([]),
      // The rules for this branch and client. Identical for every candidate, so loaded once —
      // through the engine's own loader, so the two paths cannot drift apart.
      this.ruleEngine
        .loadRules({ id: branch.id, clientId: (branch as any).clientId })
        .catch(() => [] as BusinessRuleEntity[]),
      // Prior visits to THIS branch, per candidate.
      assayerIds.length
        ? this.assignmentRepository
            .createQueryBuilder('a')
            .innerJoin('a.projectBranch', 'pb')
            .select('a.assayerId', 'assayerId')
            .addSelect('COUNT(*)::int', 'count')
            .where('a.isActive = true')
            .andWhere('pb.branchId = :branchId', { branchId: branch.id })
            .andWhere('a.status IN (:...statuses)', {
              statuses: [AssignmentStatus.ACCEPTED, AssignmentStatus.COMPLETED],
            })
            .andWhere('a.assayerId IN (:...ids)', { ids: assayerIds })
            .groupBy('a.assayerId')
            .getRawMany()
            .catch(() => [])
        : Promise.resolve([]),
      // Everything each candidate is already booked for that day, with the branch coordinates
      // the grouping bonus measures against. Matched on the date-only business key — the
      // per-candidate versions of this compared the `date` column with a Date carrying a time,
      // which Postgres never satisfies, so both same-day rules were inert.
      assayerIds.length
        ? this.assignmentRepository
            .createQueryBuilder('a')
            .innerJoin('a.projectBranch', 'pb')
            .innerJoin('pb.branch', 'br')
            .select('a.assayerId', 'assayerId')
            .addSelect('a.status', 'status')
            .addSelect('br.latitude', 'latitude')
            .addSelect('br.longitude', 'longitude')
            .where('a.isActive = true')
            .andWhere('a.scheduledDate = :day', { day: businessDateKey(scheduledDate) })
            .andWhere('a.assayerId IN (:...ids)', { ids: assayerIds })
            .getRawMany()
            .catch(() => [])
        : Promise.resolve([]),
      // Staff remarks for the pool, last 365 days, rated only — one query, owned by the
      // remarks module. A failure here scores everyone neutral (50) rather than failing the
      // recommendation; a missing opinion is not a reason to give no answer.
      this.remarksServiceForFacts
        .loadScoringWindow(assayerIds)
        .catch(() => ({}) as Record<string, RemarkForScoring[]>),
      // Offers per candidate in the last 30 days, any status. `createdAt` is when the offer was
      // made, which is the "had a turn" event fairness is about — not the scheduled date, which
      // may be weeks away, and not acceptance, which would let a serial decliner look starved.
      assayerIds.length
        ? this.assignmentRepository
            .createQueryBuilder('a')
            .select('a.assayerId', 'assayerId')
            .addSelect('COUNT(*)::int', 'count')
            .where('a.isActive = true')
            .andWhere('a.createdAt >= :since', {
              since: new Date(Date.now() - FAIRNESS_OFFER_WINDOW_DAYS * 86_400_000),
            })
            .andWhere('a.assayerId IN (:...ids)', { ids: assayerIds })
            .groupBy('a.assayerId')
            .getRawMany()
            .catch(() => [])
        : Promise.resolve([]),
      // The operator's fairness cap, once per recommendation. The default is what the
      // calculator would use anyway, so a settings outage changes nothing.
      this.platformSettings
        .getNumber(FAIRNESS_OFFER_CAP_SETTING, DEFAULT_FAIRNESS_OFFER_CAP)
        .catch(() => DEFAULT_FAIRNESS_OFFER_CAP),
    ]);

    const recentOffersByAssayer = (recentOfferRows as any[]).reduce<Record<string, number>>((acc, r) => {
      acc[r.assayerId] = Number(r.count) || 0;
      return acc;
    }, {});

    const priorVisitsByAssayer = (priorVisitRows as any[]).reduce<Record<string, number>>((acc, r) => {
      acc[r.assayerId] = Number(r.count) || 0;
      return acc;
    }, {});

    const sameDayAcceptedCountByAssayer: Record<string, number> = {};
    const sameDayBranchPointsByAssayer: Record<string, Array<{ latitude: number; longitude: number }>> = {};
    for (const row of sameDayRows as any[]) {
      if (row.status === AssignmentStatus.ACCEPTED) {
        sameDayAcceptedCountByAssayer[row.assayerId] = (sameDayAcceptedCountByAssayer[row.assayerId] ?? 0) + 1;
      }
      if (row.latitude != null && row.longitude != null) {
        (sameDayBranchPointsByAssayer[row.assayerId] ??= []).push({
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
        });
      }
    }

    const doubleBookedByAssayer = (doubleBookedRows as any[]).reduce<Record<string, string>>((acc, r) => {
      acc[r.assayerId] = r.assignmentNumber ?? 'an existing assignment';
      return acc;
    }, {});

    // Capped at 20 per assayer, matching the `take: 20` the per-candidate query applied.
    const completedByAssayer = (completedRows as any[]).reduce<Record<string, any[]>>((acc, r) => {
      const list = (acc[r.assayerId] ||= []);
      if (list.length < 20) list.push({ completionDate: r.completionDate ?? null, createdAt: r.createdAt });
      return acc;
    }, {});

    const commercialProfilesByAssayer = (profileRows as any[]).reduce<Record<string, any[]>>((acc, p) => {
      (acc[p.assayerId] ||= []).push(p);
      return acc;
    }, {});

    const queryCountByAssayer = (queryRows as any[]).reduce<Record<string, number>>((acc, r) => {
      acc[r.assayerId] = Number(r.count) || 0;
      return acc;
    }, {});

    const acceptedByAssayer = (acceptedRows as any[]).reduce<Record<string, number>>((acc, r) => {
      acc[r.assayerId] = Number(r.count) || 0;
      return acc;
    }, {});

    // Every candidate gets an entry, including those with no history at all — otherwise the
    // scorer would fall through to its own queries for exactly the assayers with no rows.
    const assignmentTotalsByAssayer = assayerIds.reduce<Record<string, { total: number; accepted: number }>>((acc, id) => {
      const total = (totalRows as any[]).find((r) => r.assayerId === id);
      acc[id] = { total: Number(total?.count) || 0, accepted: acceptedByAssayer[id] ?? 0 };
      return acc;
    }, {});

    context.branchFacts = {
      lastAssignment: lastAssignment
        ? { assayerId: lastAssignment.assayerId, status: lastAssignment.status }
        : null,
      activeWorkloadByAssayer: (workloadRows as any[]).reduce<Record<string, number>>((acc, r) => {
        acc[r.assayerId] = Number(r.count) || 0;
        return acc;
      }, {}),
      routeByAssayer,
      projectBranch: projectBranchRow,
      commercialProfilesByAssayer,
      queryCountByAssayer,
      assignmentTotalsByAssayer,
      doubleBookedByAssayer,
      completedByAssayer,
      rules: rules as BusinessRuleEntity[],
      priorVisitsByAssayer,
      sameDayAcceptedCountByAssayer,
      sameDayBranchPointsByAssayer,
      remarksByAssayer: remarksByAssayer as Record<string, RemarkForScoring[]>,
      recentOffersByAssayer,
      fairnessOfferCap: Number(fairnessOfferCap) || DEFAULT_FAIRNESS_OFFER_CAP,
    };

    // Empanelment standing with this client, one grouped query for the pool. Vetting records
    // a partner's explicit "no" (see the qualification profile); until this map existed that
    // decision fed planning nothing and a REJECTED assayer kept being offered to that client.
    if (context.client && assayerIds.length) {
      const empanelmentRows: Array<{ assayer_id: string; status: string }> = await this.assignmentRepository.manager
        .query(
          `SELECT assayer_id, status FROM assayer_client_empanelments
            WHERE client_id = $1 AND is_active = true AND assayer_id = ANY($2)`,
          [context.client.id, assayerIds],
        )
        .catch(() => []);
      context.branchFacts.empanelmentStatusByAssayer = empanelmentRows.reduce<Record<string, string>>((acc, r) => {
        acc[r.assayer_id] = r.status;
        return acc;
      }, {});
    }

    // Identify the assayer (if any) currently holding an unconfirmed PENDING offer on this
    // branch, so they can still be surfaced as a candidate (e.g. as their own backup reference,
    // or simply visible while ops decides) but flagged distinctly rather than hidden outright.
    const pendingOffer = await this.assignmentRepository.findOne({
      where: {
        projectBranch: { branchId: branch.id },
        status: AssignmentStatus.PENDING,
        isActive: true,
      },
      relations: ['projectBranch'],
    });

    const candidates = [];
    // Excluded candidates are recorded rather than silently dropped. Ops repeatedly hits
    // "why isn't <assayer> in this list?" — a shorter list with no explanation is the least
    // actionable possible answer, and it hides genuine data problems (an expired
    // certification, a full diary) behind an apparently-normal result.
    const excluded: {
      assayerId: string;
      displayName: string;
      reason: string;
      detail?: string;
      kind: 'DATE' | 'ROTATION' | 'DISTANCE' | 'POLICY' | 'SKILLS' | 'ONBOARDING';
      distanceKm: number | null;
      /**
       * Whether `distanceKm` is a road figure or a straight line — see `RouteSource`. Carried
       * so the panel can say "212 km by road" or "~164 km (straight line, estimate)" and never
       * dress the second up as the first. Null exactly when `distanceKm` is.
       */
      distanceSource: RouteSource | null;
      nextAvailableDate: string | null;
    }[] = [];

    for (const assayer of assayers) {
      let blockedBy: string | null = null;
      for (const filter of this.filters) {
        if (!(await filter.evaluate(assayer, context))) {
          blockedBy = filter.name;
          break;
        }
      }

      if (blockedBy) {
        let detail: string | undefined;
        if (blockedBy === this.ruleEngineEligibilityFilter.name) {
          detail = (await this.ruleEngineEligibilityFilter.explain(assayer, context)).join('; ') || undefined;
        } else if (blockedBy === this.deployabilityFilter.name) {
          // Which onboarding stage they are stuck at, and the click that unsticks them.
          detail = this.deployabilityFilter.explain(assayer);
        } else if (blockedBy === this.requiredSkillsFilter.name) {
          /**
           * Which skill or certification, not merely that one is missing.
           *
           * "Missing a skill or certification this project requires" is unactionable when it is
           * the answer for most of the roster: an operator cannot tell whether to send someone on
           * a course, renew a lapsed certificate, or simply record an attribute nobody typed in.
           * `checkSkillsAndCertifications` already names them; it was just being thrown away.
           *
           * This is not hypothetical tidying. On this deployment 25 of 26 active assayers hold
           * none of the three attributes the gold-audit projects require, so every branch of
           * those projects can only ever match one person, 1,200 km away — and the screen said
           * nothing about why.
           */
          const pb = context.branchFacts?.projectBranch;
          if (pb?.project) {
            detail = this.constraintEvaluator
              .checkSkillsAndCertifications(assayer, pb.project, context.scheduledDate)
              .reason;
          }
        }

        // DATE-kind exclusions are candidates for ANOTHER day, and ops needs enough to act on
        // that: when the block is a leave, the first day after it; when it is a booking, any
        // other date works (nextAvailableDate stays null and the kind alone says "date-bound").
        const kind = EXCLUSION_KINDS[blockedBy] ?? 'POLICY';
        let nextAvailableDate: string | null = null;
        if (kind === 'DATE') {
          const dateKey = businessDateKey(context.scheduledDate);
          const leave = ((assayer as any).leaves ?? []).find(
            (l: { startDate?: string; endDate?: string }) =>
              l?.startDate && l?.endDate && l.startDate <= dateKey && dateKey <= l.endDate,
          );
          if (leave) {
            const after = new Date(`${leave.endDate}T00:00:00`);
            after.setDate(after.getDate() + 1);
            nextAvailableDate = after.toISOString().slice(0, 10);
          }
        }

        excluded.push({
          assayerId: assayer.id,
          displayName: assayer.displayName,
          reason: EXCLUSION_REASONS[blockedBy] ?? blockedBy,
          detail,
          kind,
          // Already computed for the whole pool — free context for the ops decision.
          distanceKm: routeByAssayer[assayer.id]?.distanceKm ?? null,
          distanceSource: routeByAssayer[assayer.id]?.source ?? null,
          nextAvailableDate,
        });
        continue;
      }

      let weightedSum = 0;
      let totalWeight = 0;
      const scoreBreakdown: Record<string, number> = {};
      const weightUsed: Record<string, number> = {};

      for (const calculator of this.calculators) {
        const score = await calculator.calculate(assayer, context);
        scoreBreakdown[calculator.name] = score;

        // Coerced: client planningPreferences arrive from jsonb, and one string-typed weight
        // ("0.14" instead of 0.14) written via the API turns `totalWeight +=` into string
        // concatenation → NaN → every candidate scores exactly 0.00. Number() keeps a bad
        // write from zeroing the whole list.
        const weight = Number(context.weights[calculator.name]) || 0;
        weightUsed[calculator.name] = weight;
        weightedSum += score * weight;
        totalWeight += weight;
      }

      const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

      /**
       * What each dimension actually contributed to the final score, in points.
       *
       * The raw 0–100 breakdown says how the candidate did on a dimension, not how much that
       * mattered. Explaining a match by the highest raw scores therefore led with dimensions
       * carrying a weight of zero — `customerDensity` is near-always 100 and weighted 0.00, so
       * "right size for this branch" was routinely quoted as the reason for a ranking it had no
       * part in. These sum to the final score, so the card can say which three dimensions
       * actually produced it.
       */
      const contribution: Record<string, number> = {};
      for (const [name, score] of Object.entries(scoreBreakdown)) {
        contribution[name] = totalWeight > 0
          ? parseFloat(((score * (weightUsed[name] ?? 0)) / totalWeight).toFixed(2))
          : 0;
      }

      candidates.push({
        assayer,
        score: parseFloat(finalScore.toFixed(2)),
        breakdown: scoreBreakdown,
        contribution,
        pendingOnThisBranch: pendingOffer?.assayerId === assayer.id,
        // Only set when the date checks were relaxed and this candidate would otherwise have
        // been dropped. Relaxing the filter must not quietly hide the clash — the operator
        // asked to see past it, not to be kept from knowing about it.
        dateConflict: context.relaxAvailability
          ? this.describeDateConflict(assayer, context)
          : null,
        // What staff have said, summarised exactly as the remarks scorer read it — count,
        // recency-weighted mean and the latest remark — so the card can show the words behind
        // the number. Computed from the shared facts; no extra query.
        remarkSummary: await this.remarksCalculator.summaryFor(assayer, context),
        /**
         * The route the scorers just used, handed back rather than recomputed.
         *
         * `planning.service.ts` used to call `calculateRoute` again per candidate to get a
         * distance for the response — N lookups after this method had already batched them all
         * into one `/table` call. Worse, it copied only `distanceKm`, so `durationMinutes` and
         * `source` never left this class: the API could not say whether "266 km" was measured
         * by road or estimated by straight line, which is precisely the distinction that makes
         * the OSRM fallback honest. Returning the same object closes both.
         */
        route: context.branchFacts?.routeByAssayer[assayer.id] ?? null,
      });
    }

    /**
     * The assayers the geographic pre-filter removed before any rule ran.
     *
     * Appended last so the rule-based exclusions — the ones an operator can actually act on —
     * stay at the top of the panel. These are reported purely so nobody is invisible: an
     * assayer whose pin is on the map but who appears in neither list is the exact question
     * this panel exists to answer.
     */
    for (const p of prunedByDistance) {
      excluded.push({
        assayerId: p.id,
        displayName: p.displayName,
        reason: `Outside the ${Math.round(prefilterRadiusKm)} km candidate search area for this branch`,
        // The pre-filter measured on a sphere (ST_DistanceSphere), never on the road, and the
        // search area itself is a great-circle radius — so this figure is a straight line and
        // is labelled as one. It was never routed, so there is no road figure to prefer.
        detail: `~${p.distanceKm.toFixed(0)} km away (straight line). Widen the client's serviceability radius to consider them.`,
        kind: 'DISTANCE',
        distanceKm: p.distanceKm,
        distanceSource: 'ESTIMATE',
        nextAvailableDate: null,
      });
    }

    // Tied scores break by assayer id, not by whatever order Postgres returned — with most of
    // the roster geocoded to shared centroids, full ties are common, and an unordered tiebreak
    // makes the top pick (and therefore who coverage planning OFFERS the work to) flip between
    // runs. An audit must be able to reproduce why a person was chosen.
    const ranked = candidates.sort((a, b) => b.score - a.score || a.assayer.id.localeCompare(b.assayer.id));
    // Attached to the array so existing callers that just iterate results keep working
    // unchanged, while callers that want the audit trail can read it.
    (ranked as any).excluded = excluded;
    return ranked;
  }
}

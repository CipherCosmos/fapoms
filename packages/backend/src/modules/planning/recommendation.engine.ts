import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { AssayerEntity, AssayerWithWorkforceAttributes } from '../assayer/assayer.entity';
import { AssayerService } from '../assayer/assayer.service';
import { BranchEntity } from '../branch/branch.entity';
import { RoutingService } from '../geo/routing.provider';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AssignmentStatus, AssayerStatus, calculateHaversineDistance } from '@fapoms/shared';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ClientEntity } from '../client/client.entity';
import { RuleEngine } from '../platform/rules/rule.engine';
import { ConfigurationResolver } from '../platform/configuration/configuration.resolver';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { ConstraintEvaluator } from './constraint.evaluator';

/**
 * Human-readable reason per filter name. Ops sees these, not internal filter identifiers.
 */
const EXCLUSION_REASONS: Record<string, string> = {
  availability: 'Unavailable on this date (already booked, on leave, or inactive)',
  consecutiveBranchAudit: 'Audited this branch most recently — rotation rule prevents repeat auditor',
  clientRestriction: 'Restricted by this client',
  clientEligibility: 'Not approved to work for this client',
  ruleEngineEligibility: 'Blocked by a business rule',
  requiredSkills: 'Missing a skill or certification this project requires',
};

export interface PlanningContext {
  branch: BranchEntity;
  client: ClientEntity | null;
  scheduledDate: Date;
  weights: Record<string, number>;
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
     */
    routeByAssayer: Record<string, { distanceKm: number; durationMinutes: number }>;
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

@Injectable()
export class AvailabilityFilter implements CandidateFilter {
  name = 'availability';

  constructor(
    private readonly constraintEvaluator: ConstraintEvaluator,
  ) {}

  async evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean> {
    if (assayer.status !== 'ACTIVE' || !assayer.isActive) {
      return false;
    }

    // 1. Check double booking
    const dbResult = await this.constraintEvaluator.checkDoubleBooking(assayer.id, context.scheduledDate);
    if (!dbResult.passed) {
      return false;
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
      return false;
    }

    return true;
  }
}

@Injectable()
export class ClientRestrictionFilter implements CandidateFilter {
  name = 'clientRestriction';

  async evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean> {
    if (!context.client) return true;
    const restricted = context.client.restrictedAssayers || [];
    return !restricted.includes(assayer.id);
  }
}

@Injectable()
export class ClientEligibilityFilter implements CandidateFilter {
  name = 'clientEligibility';

  async evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean> {
    if (!context.client) return true;
    const eligible = assayer.eligibleClients || [];
    if (eligible.length === 0 || eligible.includes('*') || eligible.includes('ANY') || eligible.includes('ALL')) {
      return true;
    }
    return eligible.includes(context.client.clientCode) || eligible.includes(context.client.id);
  }
}

@Injectable()
export class RuleEngineEligibilityFilter implements CandidateFilter {
  name = 'ruleEngineEligibility';

  constructor(
    private readonly ruleEngine: RuleEngine,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
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
            status: In([AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS]),
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
    });
    // If any active rule block action fails, return false
    return !results.some((r) => !r.passed && r.actionType === 'BLOCK');
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
            status: In([AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS]),
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
    });
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

    const checkResult = this.constraintEvaluator.checkSkillsAndCertifications(assayer, pb.project);
    return checkResult.passed;
  }
}

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
    return Math.max(0, 100 - (route.distanceKm / 5));
  }
}

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
    return Math.max(0, 100 - (route.durationMinutes / 6));
  }
}

@Injectable()
export class WorkloadScoreCalculator implements ScoreCalculator {
  name = 'workload';

  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
  ) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    const activeCount = await this.assignmentRepository.count({
      where: {
        assayerId: assayer.id,
        status: In([AssignmentStatus.ACCEPTED]),
        isActive: true,
      },
    });

    const maxCapacity = assayer.maxWeeklyWorkload || 15;
    const remaining = Math.max(0, maxCapacity - activeCount);
    return Math.min(100, (remaining / maxCapacity) * 100);
  }
}

@Injectable()
export class PerformanceScoreCalculator implements ScoreCalculator {
  name = 'performance';

  async calculate(assayer: AssayerEntity): Promise<number> {
    const rating = Number(assayer.performanceRating) || 5.0;
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

  async calculate(assayer: AssayerEntity): Promise<number> {
    const completedAssignments = await this.assignmentRepository.find({
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

    let activeProfile: AssayerCommercialProfileEntity | null = null;
    const targetDate = context.scheduledDate;
    for (const p of profiles) {
      if (p.effectiveStartDate <= targetDate && (!p.effectiveEndDate || p.effectiveEndDate >= targetDate)) {
        activeProfile = p;
        break;
      }
    }

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
    const assayerSkills = assayer.skills || [];
    const requiredSkills = preferences.requiredSkills || [];
    const preferredSkills = preferences.preferredSkills || [];

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
    const assayerCertifications = (assayer.certifications || []).map(c => c.name);
    const requiredCerts = preferences.requiredCertifications || [];
    const preferredCerts = preferences.preferredCertifications || [];

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
    const priorVisits = await this.assignmentRepository.count({
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
      const sameDayAssignments = await this.assignmentRepository.find({
        where: {
          assayerId: assayer.id,
          scheduledDate: context.scheduledDate,
          isActive: true,
        },
        relations: ['projectBranch', 'projectBranch.branch'],
      });

      let hasNearbyGrouping = false;
      for (const assign of sameDayAssignments) {
        const otherBranch = assign.projectBranch?.branch;
        if (otherBranch && otherBranch.latitude && otherBranch.longitude && context.branch.latitude && context.branch.longitude) {
          const dist = calculateHaversineDistance(
            Number(context.branch.latitude),
            Number(context.branch.longitude),
            Number(otherBranch.latitude),
            Number(otherBranch.longitude)
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
      const activeSameDayCount = await this.assignmentRepository.count({
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
    const rating = Number(assayer.performanceRating) || 5.0;
    const exp = Number(assayer.experienceYears) || 0;

    if (branchRisk >= 7) {
      if (rating >= 4.5 && exp >= 4) {
        score += 15; // High reliability assayer assigned to critical SLA branch
      } else if (rating < 4.0 || exp < 2) {
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
    const customerCount = Number(context.branch.riskScore || 20);
    const maxCapacity = assayer.maxWeeklyWorkload || 50;
    // Score increases when high-customer-density branches are assigned to high-capacity assayers
    return Math.min(100, (customerCount / maxCapacity) * 100);
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

    // Newest first in the shared list, which is exactly what findOne with this ordering gave.
    const profile = context.branchFacts
      ? ((context.branchFacts.commercialProfilesByAssayer[assayer.id] ?? [])[0] ?? null)
      : await this.commercialRepository.findOne({
          where: { assayerId: assayer.id, isActive: true },
          order: { effectiveStartDate: 'DESC' },
        });

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
    const risk = Number(context.branch.riskScore) || 0;
    if (risk < 50) return 100; // Low-risk branch

    // High risk branch requires senior experience (years > 5) & high rating (> 4.5)
    const exp = assayer.experienceYears || 0;
    const rating = assayer.performanceRating || 5.0;

    if (exp >= 5 && rating >= 4.5) {
      return 100;
    }
    return Math.max(0, 100 - risk); // Penalty otherwise
  }
}

/** Per-client data a batch of recommendation runs can share. */
export interface RecommendationPreload {
  client: ClientEntity | null;
  assayers: AssayerEntity[];
}

@Injectable()
export class RecommendationEngine {
  private static readonly logger = new Logger(RecommendationEngine.name);
  private filters: CandidateFilter[] = [];
  private calculators: ScoreCalculator[] = [];

  constructor(
    private readonly availabilityFilter: AvailabilityFilter,
    private readonly consecutiveBranchAuditFilter: ConsecutiveBranchAuditFilter,
    private readonly clientRestrictionFilter: ClientRestrictionFilter,
    private readonly clientEligibilityFilter: ClientEligibilityFilter,
    private readonly ruleEngineEligibilityFilter: RuleEngineEligibilityFilter,
    private readonly requiredSkillsFilter: RequiredSkillsFilter,
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
    private readonly engineRoutingService: RoutingService,
    private readonly assayerService: AssayerService,
  ) {
    this.filters.push(
      this.availabilityFilter,
      this.consecutiveBranchAuditFilter,
      this.clientRestrictionFilter,
      this.clientEligibilityFilter,
      this.ruleEngineEligibilityFilter,
      this.requiredSkillsFilter,
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

    const assayers = await this.assayerRepository.find({
      where: { isActive: true, status: AssayerStatus.ACTIVE },
    });
    await this.assayerService.hydrateAllWorkforceAttributes(assayers);

    return { client, assayers };
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
    };

    // Reused from the preload when a batch caller supplied one; hydration is idempotent and
    // the scorers only read these, so sharing one list across branches is safe.
    let assayers = preloaded?.assayers;
    if (!assayers) {
      assayers = await this.assayerRepository.find({
        where: { isActive: true, status: AssayerStatus.ACTIVE },
      });
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
          statuses: [AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS],
        })
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
     * One route per candidate instead of two.
     *
     * The distance and travel-time scorers each routed the same origin/destination pair, so a
     * pool of N candidates produced 2N calls to the routing provider — the single most
     * expensive operation here, since it can be an external service. Computed once, in
     * parallel across candidates, and shared. A failed route is omitted rather than defaulted,
     * so the scorers fall through to their own call and no candidate is silently scored zero.
     */
    const routeByAssayer: Record<string, { distanceKm: number; durationMinutes: number }> = {};
    if (branch.latitude && branch.longitude) {
      const routed = await Promise.all(
        assayers.map(async (a) => {
          if (!a.effectiveLatitude || !a.effectiveLongitude) return null;
          const route = await this.engineRoutingService
            .calculateRoute(
              { latitude: Number(branch.latitude), longitude: Number(branch.longitude) },
              { latitude: Number(a.effectiveLatitude), longitude: Number(a.effectiveLongitude) },
            )
            .catch(() => null);
          return route ? ([a.id, route] as const) : null;
        }),
      );
      for (const entry of routed) {
        if (entry) routeByAssayer[entry[0]] = { distanceKm: entry[1].distanceKm, durationMinutes: entry[1].durationMinutes };
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
    const [profileRows, queryRows, totalRows, acceptedRows] = await Promise.all([
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
    ]);

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
    };

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
    const excluded: { assayerId: string; displayName: string; reason: string; detail?: string }[] = [];

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
        }
        excluded.push({
          assayerId: assayer.id,
          displayName: assayer.displayName,
          reason: EXCLUSION_REASONS[blockedBy] ?? blockedBy,
          detail,
        });
        continue;
      }

      let weightedSum = 0;
      let totalWeight = 0;
      const scoreBreakdown: Record<string, number> = {};

      for (const calculator of this.calculators) {
        const score = await calculator.calculate(assayer, context);
        scoreBreakdown[calculator.name] = score;

        const weight = context.weights[calculator.name] ?? 0;
        weightedSum += score * weight;
        totalWeight += weight;
      }

      const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

      candidates.push({
        assayer,
        score: parseFloat(finalScore.toFixed(2)),
        breakdown: scoreBreakdown,
        pendingOnThisBranch: pendingOffer?.assayerId === assayer.id,
      });
    }

    const ranked = candidates.sort((a, b) => b.score - a.score);
    // Attached to the array so existing callers that just iterate results keep working
    // unchanged, while callers that want the audit trail can read it.
    (ranked as any).excluded = excluded;
    return ranked;
  }
}

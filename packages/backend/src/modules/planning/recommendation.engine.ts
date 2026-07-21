import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { AssayerEntity } from '../assayer/assayer.entity';
import { BranchEntity } from '../branch/branch.entity';
import { RoutingService } from '../geo/routing.provider';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AssignmentStatus } from '@fapoms/shared';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ClientEntity } from '../client/client.entity';
import { RuleEngine } from '../platform/rules/rule.engine';
import { ConfigurationResolver } from '../platform/configuration/configuration.resolver';

export interface PlanningContext {
  branch: BranchEntity;
  client: ClientEntity | null;
  scheduledDate: Date;
  weights: Record<string, number>;
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
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
  ) {}

  async evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean> {
    if (assayer.status !== 'ACTIVE' || !assayer.isActive) {
      return false;
    }

    const doubleBooked = await this.assignmentRepository.findOne({
      where: {
        assayerId: assayer.id,
        scheduledDate: context.scheduledDate,
        status: In([AssignmentStatus.ACCEPTED, AssignmentStatus.SCHEDULED]),
        isActive: true,
      },
    });

    return !doubleBooked;
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
export class RuleEngineEligibilityFilter implements CandidateFilter {
  name = 'ruleEngineEligibility';

  constructor(private readonly ruleEngine: RuleEngine) {}

  async evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean> {
    const results = await this.ruleEngine.evaluate({
      subject: {
        id: assayer.id,
        state: assayer.state,
        skills: assayer.skills || [],
        certifications: assayer.certifications || [],
      },
      target: {
        id: context.branch.id,
        clientId: context.branch.clientId,
      },
      scheduledDate: context.scheduledDate,
      restrictedAssayers: context.client?.restrictedAssayers,
    });
    // If any active rule block action fails, return false
    return !results.some((r) => !r.passed && r.actionType === 'BLOCK');
  }
}

@Injectable()
export class DistanceScoreCalculator implements ScoreCalculator {
  name = 'distance';

  constructor(private readonly routingService: RoutingService) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    if (!context.branch.latitude || !context.branch.longitude || !assayer.latitude || !assayer.longitude) {
      return 0;
    }
    const route = await this.routingService.calculateRoute(
      { latitude: context.branch.latitude, longitude: context.branch.longitude },
      { latitude: assayer.latitude, longitude: assayer.longitude },
    );
    return Math.max(0, 100 - route.distanceKm);
  }
}

@Injectable()
export class TravelTimeScoreCalculator implements ScoreCalculator {
  name = 'travelTime';

  constructor(private readonly routingService: RoutingService) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    if (!context.branch.latitude || !context.branch.longitude || !assayer.latitude || !assayer.longitude) {
      return 0;
    }
    const route = await this.routingService.calculateRoute(
      { latitude: context.branch.latitude, longitude: context.branch.longitude },
      { latitude: assayer.latitude, longitude: assayer.longitude },
    );
    return Math.max(0, 100 - route.durationMinutes);
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
        status: In([AssignmentStatus.CREATED, AssignmentStatus.ACCEPTED, AssignmentStatus.SCHEDULED]),
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
    const rating = assayer.performanceRating || 5.0;
    return (rating / 5.0) * 100;
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

@Injectable()
export class CostScoreCalculator implements ScoreCalculator {
  name = 'cost';

  constructor(
    @InjectRepository(AssayerCommercialProfileEntity)
    private readonly commercialRepository: Repository<AssayerCommercialProfileEntity>,
  ) {}

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    const profiles = await this.commercialRepository.find({
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

    const baseFee = Number(activeProfile.baseFee) || 0;
    return Math.max(0, 100 - (baseFee / 5000) * 100);
  }
}

@Injectable()
export class ClientPreferenceScoreCalculator implements ScoreCalculator {
  name = 'clientPreference';

  async calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number> {
    if (context.client?.preferredAssayers?.includes(assayer.id)) {
      return 100; // Boost score for preferred assayers
    }
    return 50; // Neutral default
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
    // Count previous completed assignments of the same client
    const count = await this.assignmentRepository.count({
      where: {
        assayerId: assayer.id,
        projectId: context.branch.clientId ? context.branch.clientId : undefined,
        status: AssignmentStatus.CLOSED,
        isActive: true,
      },
    });

    // Max boost at 5 familiarity audits
    return Math.min(100, 50 + count * 10);
  }
}

@Injectable()
export class SLAComplianceScoreCalculator implements ScoreCalculator {
  name = 'slaCompliance';

  async calculate(): Promise<number> {
    return 100; // Compliance standard baseline
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

    const profile = await this.commercialRepository.findOne({
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

@Injectable()
export class RecommendationEngine {
  private filters: CandidateFilter[] = [];
  private calculators: ScoreCalculator[] = [];

  constructor(
    private readonly availabilityFilter: AvailabilityFilter,
    private readonly clientRestrictionFilter: ClientRestrictionFilter,
    private readonly ruleEngineEligibilityFilter: RuleEngineEligibilityFilter,
    private readonly distanceCalculator: DistanceScoreCalculator,
    private readonly travelTimeCalculator: TravelTimeScoreCalculator,
    private readonly workloadCalculator: WorkloadScoreCalculator,
    private readonly performanceCalculator: PerformanceScoreCalculator,
    private readonly experienceCalculator: ExperienceScoreCalculator,
    private readonly costCalculator: CostScoreCalculator,
    private readonly clientPreferenceCalculator: ClientPreferenceScoreCalculator,
    private readonly branchFamiliarityCalculator: BranchFamiliarityScoreCalculator,
    private readonly slaComplianceCalculator: SLAComplianceScoreCalculator,
    private readonly profitabilityCalculator: ProfitabilityScoreCalculator,
    private readonly riskCalculator: RiskScoreCalculator,
    private readonly configResolver: ConfigurationResolver,
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    @InjectRepository(ClientEntity)
    private readonly clientRepository: Repository<ClientEntity>,
  ) {
    this.filters.push(
      this.availabilityFilter,
      this.clientRestrictionFilter,
      this.ruleEngineEligibilityFilter,
    );

    this.calculators.push(
      this.distanceCalculator,
      this.travelTimeCalculator,
      this.workloadCalculator,
      this.performanceCalculator,
      this.experienceCalculator,
      this.costCalculator,
      this.clientPreferenceCalculator,
      this.branchFamiliarityCalculator,
      this.slaComplianceCalculator,
      this.profitabilityCalculator,
      this.riskCalculator,
    );
  }

  async recommend(
    branch: BranchEntity,
    scheduledDate: Date,
    weights: Record<string, number> = {},
  ) {
    const client = branch.clientId
      ? await this.clientRepository.findOne({ where: { id: branch.clientId, isActive: true } })
      : null;

    const resolvedConfig = this.configResolver.resolveRecommendationConfig(client, { weights });

    const context: PlanningContext = {
      branch,
      client,
      scheduledDate,
      weights: resolvedConfig.weights,
    };

    const assayers = await this.assayerRepository.find({
      where: { isActive: true, status: 'ACTIVE' },
    });

    const candidates = [];
    for (const assayer of assayers) {
      let passed = true;
      for (const filter of this.filters) {
        if (!(await filter.evaluate(assayer, context))) {
          passed = false;
          break;
        }
      }

      if (!passed) continue;

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
      });
    }

    return candidates.sort((a, b) => b.score - a.score);
  }
}

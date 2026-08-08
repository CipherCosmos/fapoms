/**
 * FAPOMS — Planning Service
 *
 * Implements candidate recommendations using PostGIS proximity search (Part 3 Module 5, Part 7 §6).
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BusinessRuleEntity } from '../platform/rules/business-rule.entity';
import { BranchQueryService } from '../branch/branch-query.service';
import { AssayerService } from '../assayer/assayer.service';

import { RecommendationEngine } from './recommendation.engine';
import { RoutingService } from '../geo/routing.provider';
import { generateExplanation, ExplanationReason } from './explainability.mapper';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory } from '@fapoms/shared';
import { FeePolicyService } from '../pricing/fee-policy.service';

export interface AssayerRecommendation {
  id: string;
  assayerCode: string;
  displayName: string;
  phone: string;
  email: string | null;
  status: string;
  state: string;
  district: string;
  city: string;
  distanceKm: number | null;
  score?: number;
  latitude?: number | null;
  longitude?: number | null;
  baseFee?: number;
  readableReasons?: ExplanationReason[];
  /** Per-dimension scores (distance, acceptanceRate, queryVolume, …) behind the total. */
  scoreBreakdown?: Record<string, number>;
  pendingOnThisBranch?: boolean;
  /** The assayer's own weekly cap, so downstream planners need not assume a platform default. */
  maxWeeklyWorkload?: number;
}

/** A candidate the filters removed, and why — surfaced so ops isn't left guessing. */
export interface ExcludedCandidate {
  assayerId: string;
  displayName: string;
  reason: string;
  detail?: string;
}

export interface CreateBusinessRuleDto {
  name: string;
  scope: string;
  targetId?: string;
  ruleType: string;
  conditions: Record<string, any>;
  actions?: Record<string, any>;
}

export interface UpdateBusinessRuleDto {
  name?: string;
  scope?: string;
  targetId?: string | null;
  ruleType?: string;
  conditions?: Record<string, any>;
  actions?: Record<string, any> | null;
}

@Injectable()
export class PlanningService {
  constructor(
    private readonly branchQueryService: BranchQueryService,
    @InjectRepository(BusinessRuleEntity)
    private readonly ruleRepository: Repository<BusinessRuleEntity>,
    private readonly assayerService: AssayerService,
    private readonly recommendationEngine: RecommendationEngine,
    private readonly routingService: RoutingService,
    private readonly auditService: AuditService,
    private readonly feePolicyService: FeePolicyService,
  ) {}

  async getRecommendedCandidates(branchId: string): Promise<AssayerRecommendation[]> {
    const branch = await this.branchQueryService.findOne(branchId);

    if (!branch) {
      throw new NotFoundException(`Branch ${branchId} not found.`);
    }

    // One date for the whole call: the same instant the engine scores against is the instant
    // the fee is quoted for, so the score and the price can never describe different days.
    const scheduledDate = new Date();
    const results = await this.recommendationEngine.recommend(branch, scheduledDate);
    const rates = await this.feePolicyService.getRates(branch.clientId ?? null);

    const recommendations: AssayerRecommendation[] = [];
    for (const r of results) {
      let distanceKm: number | null = null;
      if (branch.latitude && branch.longitude && r.assayer.effectiveLatitude && r.assayer.effectiveLongitude) {
        const route = await this.routingService.calculateRoute(
          { latitude: branch.latitude, longitude: branch.longitude },
          { latitude: r.assayer.effectiveLatitude, longitude: r.assayer.effectiveLongitude },
        );
        distanceKm = route.distanceKm;
      }

      // Quoted through the one calculator that prices the assignment itself. This used to read
      // the profile active *today* and fall back to a literal 1500, while assignment creation
      // fell back to 1200 and FeePolicyService falls back to the client's contracted rate — so
      // ops saw a figure on the candidate list that no part of the system would ever charge.
      const { baseFee } = await this.feePolicyService.resolveBaseFee(r.assayer.id, rates, scheduledDate);

      const readableReasons = generateExplanation(r.breakdown, {
        displayName: r.assayer.displayName,
        distanceKm,
        performanceRating: r.assayer.performanceRating,
        experienceYears: r.assayer.experienceYears,
        baseFee,
      });

      recommendations.push({
        id: r.assayer.id,
        assayerCode: r.assayer.assayerCode,
        displayName: r.assayer.displayName,
        phone: r.assayer.phone,
        email: r.assayer.email,
        status: r.assayer.status,
        state: r.assayer.state,
        district: r.assayer.district,
        city: r.assayer.city,
        distanceKm,
        score: r.score,
        latitude: r.assayer.effectiveLatitude,
        longitude: r.assayer.effectiveLongitude,
        baseFee,
        readableReasons,
        // Per-dimension scores so ops can see *why* this candidate ranked where they did,
        // rather than being handed an unexplained number.
        scoreBreakdown: r.breakdown,
        pendingOnThisBranch: r.pendingOnThisBranch,
        maxWeeklyWorkload: r.assayer.maxWeeklyWorkload ?? undefined,
      });
    }

    // Carried through so the UI can answer "why isn't <assayer> on this list?" — previously
    // excluded candidates just vanished, which hid real data problems (expired certification,
    // full diary) behind an apparently-normal shorter list.
    (recommendations as any).excluded = (results as any).excluded || [];
    return recommendations;
  }

  // Rule management methods
  /**
   * Business rules decide who is allowed to audit what — required certifications, capacity
   * ceilings, client restrictions, no-repeat-auditor rotation. Changing one silently changes
   * the independence controls the whole engagement rests on, so every change is recorded with
   * the rule's before and after state.
   *
   * None of these three recorded anything. A rule could be relaxed, an assignment made under
   * it, and the rule put back, leaving no evidence the control had ever been lifted.
   */
  async createRule(dto: CreateBusinessRuleDto, userId: string): Promise<BusinessRuleEntity> {
    const rule = this.ruleRepository.create({
      ...dto,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.ruleRepository.save(rule);

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'BUSINESS_RULE_CREATED',
      entityType: 'BUSINESS_RULE',
      entityId: saved.id,
      userId,
      remarks: `Created rule "${saved.name ?? saved.id}".`,
      metadata: { rule: saved },
    });

    return saved;
  }

  async updateRule(id: string, dto: UpdateBusinessRuleDto, userId: string): Promise<BusinessRuleEntity> {
    const rule = await this.ruleRepository.findOne({ where: { id, isActive: true } });
    if (!rule) {
      throw new NotFoundException(`Business rule ${id} not found.`);
    }
    // Captured before the merge so the audit row shows what the rule actually was.
    const before = { ...rule };

    Object.assign(rule, dto);
    rule.updatedBy = userId;
    const saved = await this.ruleRepository.save(rule);

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'BUSINESS_RULE_UPDATED',
      entityType: 'BUSINESS_RULE',
      entityId: saved.id,
      userId,
      remarks: `Updated rule "${saved.name ?? saved.id}".`,
      metadata: { before, after: saved, changedFields: Object.keys(dto ?? {}) },
    });

    return saved;
  }

  async deleteRule(id: string, userId: string): Promise<void> {
    const rule = await this.ruleRepository.findOne({ where: { id, isActive: true } });
    if (!rule) {
      throw new NotFoundException(`Business rule ${id} not found.`);
    }
    rule.isActive = false;
    rule.updatedBy = userId;
    await this.ruleRepository.save(rule);

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'BUSINESS_RULE_DELETED',
      entityType: 'BUSINESS_RULE',
      entityId: rule.id,
      userId,
      remarks: `Deactivated rule "${rule.name ?? rule.id}". It no longer constrains assignment.`,
      metadata: { rule },
    });
  }

  async getRules(scope?: string): Promise<BusinessRuleEntity[]> {
    const where: any = { isActive: true };
    if (scope) {
      where.scope = scope;
    }
    return this.ruleRepository.find({ where, order: { createdAt: 'DESC' } });
  }

  async getRule(id: string): Promise<BusinessRuleEntity> {
    const rule = await this.ruleRepository.findOne({ where: { id, isActive: true } });
    if (!rule) {
      throw new NotFoundException(`Business rule ${id} not found.`);
    }
    return rule;
  }
}

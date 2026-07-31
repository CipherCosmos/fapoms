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
  ) {}

  async getRecommendedCandidates(branchId: string): Promise<AssayerRecommendation[]> {
    const branch = await this.branchQueryService.findOne(branchId);

    if (!branch) {
      throw new NotFoundException(`Branch ${branchId} not found.`);
    }

    const results = await this.recommendationEngine.recommend(branch, new Date());

    const recommendations: AssayerRecommendation[] = [];
    for (const r of results) {
      let distanceKm: number | null = null;
      if (branch.latitude && branch.longitude && r.assayer.latitude && r.assayer.longitude) {
        const route = await this.routingService.calculateRoute(
          { latitude: branch.latitude, longitude: branch.longitude },
          { latitude: r.assayer.latitude, longitude: r.assayer.longitude },
        );
        distanceKm = route.distanceKm;
      }

      const profile = await this.assayerService.getActiveCommercialProfile(r.assayer.id);
      const baseFee = profile ? Number(profile.baseFee) : 1500;

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
        latitude: r.assayer.latitude,
        longitude: r.assayer.longitude,
        baseFee,
        readableReasons,
        // Per-dimension scores so ops can see *why* this candidate ranked where they did,
        // rather than being handed an unexplained number.
        scoreBreakdown: r.breakdown,
        pendingOnThisBranch: r.pendingOnThisBranch,
      });
    }

    // Carried through so the UI can answer "why isn't <assayer> on this list?" — previously
    // excluded candidates just vanished, which hid real data problems (expired certification,
    // full diary) behind an apparently-normal shorter list.
    (recommendations as any).excluded = (results as any).excluded || [];
    return recommendations;
  }

  // Rule management methods
  async createRule(dto: CreateBusinessRuleDto, userId: string): Promise<BusinessRuleEntity> {
    const rule = this.ruleRepository.create({
      ...dto,
      createdBy: userId,
      updatedBy: userId,
    });
    return this.ruleRepository.save(rule);
  }

  async updateRule(id: string, dto: UpdateBusinessRuleDto, userId: string): Promise<BusinessRuleEntity> {
    const rule = await this.ruleRepository.findOne({ where: { id, isActive: true } });
    if (!rule) {
      throw new NotFoundException(`Business rule ${id} not found.`);
    }
    Object.assign(rule, dto);
    rule.updatedBy = userId;
    return this.ruleRepository.save(rule);
  }

  async deleteRule(id: string, userId: string): Promise<void> {
    const rule = await this.ruleRepository.findOne({ where: { id, isActive: true } });
    if (!rule) {
      throw new NotFoundException(`Business rule ${id} not found.`);
    }
    rule.isActive = false;
    rule.updatedBy = userId;
    await this.ruleRepository.save(rule);
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

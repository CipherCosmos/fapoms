/**
 * FAPOMS — Planning Service
 *
 * Implements candidate recommendations using PostGIS proximity search (Part 3 Module 5, Part 7 §6).
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BranchEntity } from '../branch/branch.entity';
import { BusinessRuleEntity } from './business-rule.entity';

import { RecommendationEngine } from './recommendation.engine';
import { RoutingService } from '../geo/routing.provider';

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
    @InjectRepository(BranchEntity)
    private readonly branchRepository: Repository<BranchEntity>,
    @InjectRepository(BusinessRuleEntity)
    private readonly ruleRepository: Repository<BusinessRuleEntity>,
    private readonly recommendationEngine: RecommendationEngine,
    private readonly routingService: RoutingService,
  ) {}

  async getRecommendedCandidates(branchId: string): Promise<AssayerRecommendation[]> {
    const branch = await this.branchRepository.findOne({
      where: { id: branchId, isActive: true },
    });

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
      });
    }

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

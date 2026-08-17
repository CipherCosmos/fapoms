/**
 * FAPOMS — Planning Service
 *
 * Implements candidate recommendations using PostGIS proximity search (Part 3 Module 5, Part 7 §6).
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BusinessRuleEntity } from '../platform/rules/business-rule.entity';
import { BranchQueryService } from '../branch/branch-query.service';
import { AssayerService } from '../assayer/assayer.service';

import { RecommendationEngine } from './recommendation.engine';
import { ConstraintEvaluator } from './constraint.evaluator';
import { RoutingService } from '../geo/routing.provider';
import { generateExplanation, ExplanationReason } from './explainability.mapper';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory } from '@fapoms/shared';
import { FeePolicyService } from '../pricing/fee-policy.service';
import type { RemarkSummary } from '../assayer-remarks/assayer-remark.contract';

export interface AssayerRecommendation {
  id: string;
  assayerCode: string;
  displayName: string;
  /** Null when the roster carried no number — the desk cannot ring this candidate. */
  phone: string | null;
  email: string | null;
  status: string;
  state: string;
  district: string;
  city: string;
  distanceKm: number | null;
  /** One-way travel time in minutes, from the same source as `distanceKm`. */
  durationMinutes?: number | null;
  /** 'OSRM' when measured by road, 'ESTIMATE' when straight-line fell back in — never silent. */
  distanceSource?: 'OSRM' | 'ESTIMATE' | null;
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
  /**
   * The diary clash this candidate still has on the planned date, when the caller asked for
   * date checks to be relaxed. Null means free. Never omit it silently: relaxing a filter is a
   * request to see past a constraint, not to be kept from knowing it exists.
   */
  dateConflict?: string | null;
  /**
   * What staff have said about this person, exactly as the `remarksScore` dimension read it:
   * how many rated remarks in the last year, their recency-weighted mean (−2…+2), and the most
   * recent one. Lets the card say "3 remarks · avg −0.7" and show the words, so a moved score
   * is never a mystery. See modules/assayer-remarks.
   */
  remarkSummary?: RemarkSummary;
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
    private readonly constraintEvaluator: ConstraintEvaluator,
  ) {}

  /**
   * The smart default audit date for a branch: the first day the audit could actually be
   * worked, starting tomorrow (field audits are scheduled ahead, not same-day).
   *
   * Skips Sundays, state public holidays and non-working Saturdays via the same
   * ConstraintEvaluator rule that assignment creation enforces — so the date the planner
   * seeds is never one the platform would later reject with "Holiday Conflict". Ops can
   * always override it in the date picker; this only answers "if I don't choose, when?".
   */
  async suggestAuditDate(branchId: string): Promise<{ date: string; skipped: Array<{ date: string; reason: string }> }> {
    const branch = await this.branchQueryService.findOne(branchId);
    if (!branch) {
      throw new NotFoundException(`Branch ${branchId} not found.`);
    }

    const skipped: Array<{ date: string; reason: string }> = [];
    const candidate = new Date();
    candidate.setDate(candidate.getDate() + 1);
    const key = (d: Date) => {
      // Local calendar date, not UTC — an IST evening must not roll the date back a day.
      const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    for (let attempt = 0; attempt < 30; attempt++) {
      if (candidate.getDay() === 0) {
        skipped.push({ date: key(candidate), reason: 'Sunday' });
      } else {
        const holiday = await this.constraintEvaluator.checkHoliday(branch.state || '', candidate, branch.clientId ?? undefined);
        if (holiday.passed) {
          return { date: key(candidate), skipped };
        }
        skipped.push({ date: key(candidate), reason: holiday.reason || 'Holiday' });
      }
      candidate.setDate(candidate.getDate() + 1);
    }

    // Nothing workable within a month — hand back tomorrow rather than inventing a date,
    // and let the skipped list tell ops the calendar itself is the problem.
    const fallback = new Date();
    fallback.setDate(fallback.getDate() + 1);
    return { date: key(fallback), skipped };
  }

  async getRecommendedCandidates(
    branchId: string,
    weights: Record<string, number> = {},
    forDate?: string,
    /**
     * `relaxAvailability` turns the date-bound checks (booked, on leave) from disqualifying
     * into advisory — the whole nearby workforce is ranked and any clash is reported on the
     * row as `dateConflict`. Ops asked for it because the first question they ask a branch is
     * "who could cover this at all", which the date filter answers too narrowly.
     */
    options?: { relaxAvailability?: boolean; searchRadiusKm?: number },
  ): Promise<AssayerRecommendation[]> {
    const branch = await this.branchQueryService.findOne(branchId);

    if (!branch) {
      throw new NotFoundException(`Branch ${branchId} not found.`);
    }

    // One date for the whole call: the same instant the engine scores against is the instant
    // the fee is quoted for, so the score and the price can never describe different days.
    //
    // The date is the CALLER'S choice, not an assumption. This used to hardcode "now", so the
    // availability filter answered "who is free TODAY?" while ops was planning an audit for
    // some other day entirely — people free tomorrow showed as unavailable, and people busy
    // tomorrow showed as free. The UI passes its date picker; absent, today is kept for
    // backward-compatible callers.
    const scheduledDate = forDate ? new Date(`${forDate.slice(0, 10)}T00:00:00`) : new Date();
    if (Number.isNaN(scheduledDate.getTime())) {
      throw new BadRequestException(`Invalid date '${forDate}'. Use YYYY-MM-DD.`);
    }
    // `weights` lets the scenario sandbox pass its overrides all the way into scoring; empty by
    // default, in which case `recommend` resolves the client's own configured weights as before.
    const results = await this.recommendationEngine.recommend(branch, scheduledDate, weights, undefined, options);
    const rates = await this.feePolicyService.getRates(branch.clientId ?? null);

    // One query for every ranked candidate's contracted rate, instead of one per candidate.
    const baseFees = await this.feePolicyService.resolveBaseFees(
      results.map((r) => r.assayer.id),
      rates,
      scheduledDate,
    );

    const recommendations: AssayerRecommendation[] = [];
    for (const r of results) {
      /**
       * The route the engine already scored with. It used to be recomputed here with one
       * `calculateRoute` per candidate — N lookups straight after the engine had batched the
       * whole pool into a single `/table` request — and only `distanceKm` survived the copy, so
       * the API could never say whether a figure was measured by road or estimated. Reusing the
       * engine's own result removes the lookups and carries `durationMinutes` and `source`
       * through untouched. The lookup remains as a fallback for a result that arrived without one.
       */
      let route = r.route ?? null;
      if (!route && branch.latitude && branch.longitude && r.assayer.effectiveLatitude && r.assayer.effectiveLongitude) {
        route = await this.routingService.calculateRoute(
          { latitude: branch.latitude, longitude: branch.longitude },
          { latitude: r.assayer.effectiveLatitude, longitude: r.assayer.effectiveLongitude },
        );
      }
      const distanceKm: number | null = route?.distanceKm ?? null;

      // Quoted through the one calculator that prices the assignment itself. This used to read
      // the profile active *today* and fall back to a literal 1500, while assignment creation
      // fell back to 1200 and FeePolicyService falls back to the client's contracted rate — so
      // ops saw a figure on the candidate list that no part of the system would ever charge.
      // Resolved for the whole pool above; same rule, one query.
      const { baseFee } = baseFees.get(r.assayer.id) ?? { baseFee: rates.defaultBaseFee, usedFallback: true };

      const readableReasons = generateExplanation(r.breakdown, {
        displayName: r.assayer.displayName,
        distanceKm,
        // So the sentence says "8.3 km by road" or "~164 km (straight line, estimate)" — the
        // reason is read by a person, and an estimate must not read as a road figure.
        distanceSource: route?.source ?? null,
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
        // One-way, minutes. Real road time when `distanceSource` is OSRM; the historical
        // straight-line-at-40-km/h figure when it is ESTIMATE — the card must label the two
        // differently, so both travel together.
        durationMinutes: route?.durationMinutes ?? null,
        distanceSource: route?.source ?? null,
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
        // Present only when the date checks were relaxed and this candidate has a clash on the
        // planned date. Null/absent means genuinely free.
        dateConflict: r.dateConflict ?? null,
        remarkSummary: r.remarkSummary,
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

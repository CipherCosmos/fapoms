import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BusinessRuleEntity } from './business-rule.entity';

export interface RuleEvaluationSubject {
  id: string;
  state: string;
  skills?: string[];
  certifications?: { name: string; expiryDate?: string | Date }[];
}

export interface RuleEvaluationTarget {
  id: string;
  clientId?: string | null;
}

export interface RuleEvaluationContext {
  subject: RuleEvaluationSubject;
  target: RuleEvaluationTarget;
  scheduledDate: Date;
  activeWorkload?: number;
}

export interface RuleResult {
  passed: boolean;
  actionType: 'BLOCK' | 'SCORE_ADJUSTMENT' | 'ALERT';
  scoreModifier?: number;
  message?: string;
}

@Injectable()
export class RuleEngine {
  constructor(
    @InjectRepository(BusinessRuleEntity)
    private readonly ruleRepository: Repository<BusinessRuleEntity>,
  ) {}

  /**
   * Evaluates all applicable business rules for the given subject and target context.
   */
  /**
   * The rules that apply to one target, loaded from the database.
   *
   * Split out of `evaluate` so a caller that evaluates the SAME target many times — the
   * recommendation engine asks these rules about every candidate assayer in the pool, and the
   * rules do not depend on the assayer at all — can load them once and hand them back in.
   * Sharing the loader rather than reimplementing the `where` keeps the two paths from drifting
   * apart: a rule that a preloading caller misses is a rule that silently stops applying.
   */
  loadRules(target: RuleEvaluationTarget): Promise<BusinessRuleEntity[]> {
    return this.ruleRepository.find({
      where: [
        { scope: 'GLOBAL', isActive: true },
        { scope: 'CLIENT', targetId: target.clientId || undefined, isActive: true },
        { scope: 'BRANCH', targetId: target.id, isActive: true },
      ],
    });
  }

  /**
   * Evaluate every applicable rule. `preloadedRules` skips the lookup for callers that already
   * hold this target's rules (see loadRules); omitted, the rules are fetched as before.
   */
  async evaluate(context: RuleEvaluationContext, preloadedRules?: BusinessRuleEntity[]): Promise<RuleResult[]> {
    const rules = preloadedRules ?? (await this.loadRules(context.target));

    const results: RuleResult[] = [];

    for (const rule of rules) {
      const result = this.evaluateSingleRule(rule, context);
      results.push(result);
    }

    return results;
  }

  private evaluateSingleRule(rule: BusinessRuleEntity, context: RuleEvaluationContext): RuleResult {
    const { subject, target, scheduledDate, activeWorkload } = context;
    const cond = rule.conditions || {};
    const action = rule.actions || {};
    const actionType = (action.type as 'BLOCK' | 'SCORE_ADJUSTMENT' | 'ALERT') || 'BLOCK';
    const scoreModifier = typeof action.value === 'number' ? action.value : undefined;

    // 1. Certification Constraint
    if (rule.ruleType === 'CERTIFICATION' && cond.requiredCertification) {
      const required = String(cond.requiredCertification).toLowerCase();
      const hasCert = subject.certifications?.some(
        (c) =>
          c.name.toLowerCase() === required &&
          (!c.expiryDate || new Date(c.expiryDate) > scheduledDate),
      );
      if (!hasCert) {
        return {
          passed: false,
          actionType,
          scoreModifier,
          message: `Missing required certification: ${cond.requiredCertification}`,
        };
      }
    }

    // 2. Skill Constraint
    if (rule.ruleType === 'SKILL' && cond.requiredSkill) {
      const required = String(cond.requiredSkill).toLowerCase();
      const hasSkill = subject.skills?.some((s) => s.toLowerCase() === required);
      if (!hasSkill) {
        return {
          passed: false,
          actionType,
          scoreModifier,
          message: `Missing required skill: ${cond.requiredSkill}`,
        };
      }
    }

    // 3. Territory Restriction
    if (rule.ruleType === 'TERRITORY' && cond.restrictedStates) {
      const restricted = Array.isArray(cond.restrictedStates) ? cond.restrictedStates : [];
      if (restricted.some((state) => String(state).toLowerCase() === subject.state.toLowerCase())) {
        return {
          passed: false,
          actionType,
          scoreModifier,
          message: `Restricted state territory: ${subject.state}`,
        };
      }
    }

    // 4. Capacity Limits
    //
    // `activeWorkload` is a count of concurrent open commitments — it is not windowed to a week
    // anywhere in the platform — so the limit is expressed and reported in those terms. The
    // stored condition key is read under both spellings because rules exist under each: the UI
    // writes `maxWeeklyCapacity`, while the seeded rule uses `maxConcurrent`, and reading only
    // the first meant a rule authored with the second silently never applied.
    if (rule.ruleType === 'CAPACITY') {
      const limit = cond.maxConcurrentAssignments ?? cond.maxWeeklyCapacity ?? cond.maxConcurrent;
      /**
       * A limit of 0 is a real instruction, not an absent one.
       *
       * `if (limit)` treated 0 as "no limit configured", so a rule saying "nobody may hold an open
       * assignment" — the way an operator freezes assignment during an incident or an audit
       * pause — silently did nothing, with no warning and a rule that looked active on screen.
       * Only `null`/`undefined`/`''` mean unset; 0 means zero.
       */
      if (limit !== undefined && limit !== null && limit !== '') {
        const currentLoad = activeWorkload || 0;
        if (currentLoad >= Number(limit)) {
          return {
            passed: false,
            actionType,
            scoreModifier,
            message: `Open assignments (${currentLoad}) reached the limit of ${limit}`,
          };
        }
      }
    }

    // There is deliberately no PREFERENCE/restricted-assayers branch here: the client's
    // restricted list is enforced by ClientEligibilityFilter, the one per-client gate.

    return { passed: true, actionType: 'ALERT' };
  }
}

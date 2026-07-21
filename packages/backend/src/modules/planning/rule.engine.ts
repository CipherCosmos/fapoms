import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BusinessRuleEntity } from './business-rule.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { BranchEntity } from '../branch/branch.entity';
import { ClientEntity } from '../client/client.entity';

export interface RuleEvaluationContext {
  assayer: AssayerEntity;
  branch: BranchEntity;
  client?: ClientEntity | null;
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
   * Evaluates all applicable business rules for the candidate in the given context.
   * Returns a list of evaluation results.
   */
  async evaluate(context: RuleEvaluationContext): Promise<RuleResult[]> {
    const rules = await this.ruleRepository.find({
      where: [
        { scope: 'GLOBAL', isActive: true },
        { scope: 'CLIENT', targetId: context.branch.clientId || undefined, isActive: true },
        { scope: 'BRANCH', targetId: context.branch.id, isActive: true },
      ],
    });

    const results: RuleResult[] = [];

    for (const rule of rules) {
      const result = this.evaluateSingleRule(rule, context);
      results.push(result);
    }

    return results;
  }

  private evaluateSingleRule(rule: BusinessRuleEntity, context: RuleEvaluationContext): RuleResult {
    const { assayer, branch, client, activeWorkload } = context;
    const cond = rule.conditions || {};
    const action = rule.actions || {};
    const actionType = (action.type as 'BLOCK' | 'SCORE_ADJUSTMENT' | 'ALERT') || 'BLOCK';
    const scoreModifier = typeof action.value === 'number' ? action.value : undefined;

    // 1. Certification Constraint
    if (rule.ruleType === 'CERTIFICATION' && cond.requiredCertification) {
      const required = String(cond.requiredCertification).toLowerCase();
      const hasCert = assayer.certifications?.some(
        (c) =>
          c.name.toLowerCase() === required &&
          (!c.expiryDate || new Date(c.expiryDate) > context.scheduledDate),
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
      const hasSkill = assayer.skills?.some((s) => s.toLowerCase() === required);
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
      if (restricted.some((state) => String(state).toLowerCase() === assayer.state.toLowerCase())) {
        return {
          passed: false,
          actionType,
          scoreModifier,
          message: `Restricted state territory: ${assayer.state}`,
        };
      }
    }

    // 4. Capacity Limits
    if (rule.ruleType === 'CAPACITY' && cond.maxWeeklyCapacity) {
      const currentLoad = activeWorkload || 0;
      if (currentLoad >= Number(cond.maxWeeklyCapacity)) {
        return {
          passed: false,
          actionType,
          scoreModifier,
          message: `Weekly workload (${currentLoad}) exceeds capacity limit (${cond.maxWeeklyCapacity})`,
        };
      }
    }

    // 5. Client Restriction
    if (rule.ruleType === 'PREFERENCE' && client?.restrictedAssayers) {
      if (client.restrictedAssayers.includes(assayer.id)) {
        return {
          passed: false,
          actionType,
          scoreModifier,
          message: `Assayer restricted by client preferences`,
        };
      }
    }

    return { passed: true, actionType: 'ALERT' };
  }
}

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
export declare class RuleEngine {
    private readonly ruleRepository;
    constructor(ruleRepository: Repository<BusinessRuleEntity>);
    evaluate(context: RuleEvaluationContext): Promise<RuleResult[]>;
    private evaluateSingleRule;
}

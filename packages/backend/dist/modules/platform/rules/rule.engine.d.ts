import { Repository } from 'typeorm';
import { BusinessRuleEntity } from './business-rule.entity';
export interface RuleEvaluationSubject {
    id: string;
    state: string;
    skills?: string[];
    certifications?: {
        name: string;
        expiryDate?: string | Date;
    }[];
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
    restrictedAssayers?: string[] | null;
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

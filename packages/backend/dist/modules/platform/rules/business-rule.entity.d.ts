import { BaseEntity } from '../../../core/entities/base.entity';
export declare class BusinessRuleEntity extends BaseEntity {
    name: string;
    scope: string;
    targetId: string | null;
    ruleType: string;
    conditions: Record<string, any>;
    actions: Record<string, any> | null;
}

import { BaseEntity } from '../../core/entities/base.entity';
export declare class ClientConfigurationEntity extends BaseEntity {
    clientId: string;
    client: any;
    importMapping: Record<string, string> | null;
    workingDays: number[] | null;
    defaultRadius: number;
    slaRules: Record<string, any> | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
}

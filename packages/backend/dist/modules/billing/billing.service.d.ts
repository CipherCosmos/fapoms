import { Repository } from 'typeorm';
import { BillingRecord } from './billing-record.entity';
export declare class BillingService {
    private readonly billingRepository;
    constructor(billingRepository: Repository<BillingRecord>);
    createBillingRecord(dto: Partial<BillingRecord>): Promise<BillingRecord>;
    getAssayerBilling(assayerId: string): Promise<BillingRecord[]>;
}

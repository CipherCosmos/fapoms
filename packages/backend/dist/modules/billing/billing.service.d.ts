import { Repository } from 'typeorm';
import { BillingRecord } from './billing-record.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
export declare class BillingService {
    private readonly billingRepository;
    private readonly eventPublisher;
    constructor(billingRepository: Repository<BillingRecord>, eventPublisher: DomainEventPublisher);
    createBillingRecord(dto: Partial<BillingRecord>): Promise<BillingRecord>;
    getAssayerBilling(assayerId: string): Promise<BillingRecord[]>;
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BillingRecord } from './billing-record.entity';

@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(BillingRecord)
    private readonly billingRepository: Repository<BillingRecord>,
  ) {}

  async createBillingRecord(dto: Partial<BillingRecord>): Promise<BillingRecord> {
    const base = Number(dto.baseFee || 0);
    const travel = Number(dto.travelAllowance || 0);
    const penalty = Number(dto.penalties || 0);
    const gstRate = 0.18; // standard 18% GST
    const tdsRate = 0.10; // standard 10% TDS
    
    const taxableAmount = base + travel - penalty;
    const gstVal = taxableAmount * gstRate;
    const tdsVal = taxableAmount * tdsRate;
    const netVal = taxableAmount + gstVal - tdsVal;

    const record = this.billingRepository.create({
      ...dto,
      baseFee: base,
      travelAllowance: travel,
      penalties: penalty,
      gst: gstVal,
      tds: tdsVal,
      netPayable: netVal,
      invoiceStatus: dto.invoiceStatus || 'DRAFT',
    });
    return this.billingRepository.save(record);
  }

  async getAssayerBilling(assayerId: string): Promise<BillingRecord[]> {
    return this.billingRepository.find({ where: { assayerId } });
  }
}

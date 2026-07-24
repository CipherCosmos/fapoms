import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditHistoryRecord } from './audit-history.entity';
import { AuditEvidence } from './audit-evidence.entity';

@Injectable()
export class AuditHistoryService {
  constructor(
    @InjectRepository(AuditHistoryRecord)
    private readonly historyRepository: Repository<AuditHistoryRecord>,
    @InjectRepository(AuditEvidence)
    private readonly evidenceRepository: Repository<AuditEvidence>,
  ) {}

  async createRecord(dto: Partial<AuditHistoryRecord>): Promise<AuditHistoryRecord> {
    const record = this.historyRepository.create(dto);
    return this.historyRepository.save(record);
  }

  async addEvidence(dto: Partial<AuditEvidence>): Promise<AuditEvidence> {
    const evidence = this.evidenceRepository.create(dto);
    return this.evidenceRepository.save(evidence);
  }

  async getAssayerAudits(assayerId: string): Promise<AuditHistoryRecord[]> {
    return this.historyRepository.find({ where: { assayerId } });
  }

  async getAuditEvidence(auditId: string): Promise<AuditEvidence[]> {
    return this.evidenceRepository.find({ where: { auditId } });
  }
}

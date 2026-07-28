import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLogEntity } from './audit-log.entity';

@Injectable()
export class PlatformAuditService {
  constructor(
    @InjectRepository(AuditLogEntity)
    private readonly auditRepository: Repository<AuditLogEntity>,
  ) {}

  async logAction(params: {
    tenantId: string | null;
    userId: string;
    action: string;
    beforeState?: any;
    afterState?: any;
    justification?: string;
    ipAddress?: string;
    correlationId?: string;
  }): Promise<AuditLogEntity> {
    const log = this.auditRepository.create({
      tenantId: params.tenantId,
      userId: params.userId,
      action: params.action,
      beforeState: params.beforeState || null,
      afterState: params.afterState || null,
      justification: params.justification || null,
      ipAddress: params.ipAddress || null,
      correlationId: params.correlationId ? params.correlationId : null,
    });
    return this.auditRepository.save(log);
  }
}

/**
 * FAPOMS — Audit Module
 *
 * Provides the AuditService globally to all modules.
 */

import { Module, Global, OnModuleInit, Logger } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { AuditEventEntity } from './audit-event.entity';
import { AuditChainEntity } from './audit-chain.entity';
import { AuditService } from './audit.service';
import { UnifiedAuditService } from './unified-audit.service';
import { AuditLogController } from './audit.controller';
import { AuditRepository } from './audit.repository';
import { TypeOrmAuditRepository } from './typeorm-audit.repository';
import { AuditReadInterceptor } from './audit-read.interceptor';
import { AuditSealService } from './audit-seal.service';
import { AuditSealWorker } from './audit-seal.worker';
import { ensureRepeatableSchedules } from '../../infrastructure/queue/repeatable-schedules';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([AuditEventEntity, AuditChainEntity]),
    BullModule.registerQueue({ name: 'audit-seal' }),
  ],
  controllers: [AuditLogController],
  providers: [
    AuditService,
    UnifiedAuditService,
    AuditSealService,
    AuditSealWorker,
    { provide: AuditRepository, useClass: TypeOrmAuditRepository },
    // Global, but inert unless a handler carries @AuditRead — records access to personal data
    // (DPDP/RBI access logging). Registered here so it gets Reflector + AuditService by DI.
    { provide: APP_INTERCEPTOR, useClass: AuditReadInterceptor },
  ],
  exports: [AuditService, UnifiedAuditService, AuditSealService],
})
export class AuditModule implements OnModuleInit {
  private readonly logger = new Logger(AuditModule.name);

  // Every minute: keep the tamper-evidence lag small. See AuditSealWorker.
  private static readonly SEAL_CRON = '* * * * *';

  constructor(@InjectQueue('audit-seal') private readonly queue: Queue) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    ensureRepeatableSchedules(
      this.queue,
      [{ name: 'seal', cron: AuditModule.SEAL_CRON, jobOptions: { attempts: 1 } }],
      this.logger,
    );
  }
}

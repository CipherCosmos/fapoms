import { Module } from '@nestjs/common';
import { AuditModule } from '../../core/audit/audit.module';
import { NotificationsModule } from '../../modules/notifications/notifications.module';
import { DataResetController } from './data-reset.controller';
import { DataResetService } from './data-reset.service';
import { DestructiveApprovalService } from './destructive-approval.service';
import { FkGraphService } from './fk-graph.service';
import { BackupOnDemandService } from './backup-on-demand.service';

/**
 * The developer "clean the database" feature, plus the two-person rule that gates it
 * (DestructiveApprovalService: a DEVELOPER requests, an ADMIN approves, the requester executes).
 *
 * Needs `AuditModule` for the audit writes and `NotificationsModule` for the approval-flow
 * notifications (request filed → admins; decided → the requester). The `DataSource` used
 * throughout comes from the root `TypeOrmModule`, already global, so no feature import is needed
 * for it — the approval service deliberately keeps the same raw-DataSource style as
 * `DataResetService`, so there is no `forFeature` here either.
 */
@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [DataResetController],
  providers: [DataResetService, DestructiveApprovalService, FkGraphService, BackupOnDemandService],
})
export class DataResetModule {}

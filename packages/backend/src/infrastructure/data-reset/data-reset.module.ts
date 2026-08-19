import { Module } from '@nestjs/common';
import { AuditModule } from '../../core/audit/audit.module';
import { DataResetController } from './data-reset.controller';
import { DataResetService } from './data-reset.service';
import { FkGraphService } from './fk-graph.service';
import { BackupOnDemandService } from './backup-on-demand.service';

/**
 * The super-administrator "clean the database" feature. Needs `AuditModule` for the one audit
 * write `execute()` makes; the `DataSource` used throughout comes from the root `TypeOrmModule`,
 * already global, so no feature import is needed for it.
 */
@Module({
  imports: [AuditModule],
  controllers: [DataResetController],
  providers: [DataResetService, FkGraphService, BackupOnDemandService],
})
export class DataResetModule {}

/**
 * FAPOMS — Project Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProjectService } from './project.service';
import { BranchImportJob } from './branch-import/branch-import.job';
import { BranchImportStore } from './branch-import/branch-import.store';
import { BranchEntity } from '../branch/branch.entity';
import { ProjectQueryService } from './project-query.service';
import { ProjectController } from './project.controller';
import { BranchImportController } from './branch-import.controller';
import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { AssessmentEntity } from './assessment.entity';
import { CallLogEntity } from './call-log.entity';
import { CallLogService } from './call-log.service';
import { CallLogController } from './call-log.controller';
import { ClientEntity } from '../client/client.entity';
import { UserEntity } from '../user/user.entity';
import { ZoneEntity } from '../zone/zone.entity';
import { PlatformModule } from '../platform/platform.module';
import { BranchModule } from '../branch/branch.module';
import { GeoModule } from '../geo/geo.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssayerModule } from '../assayer/assayer.module';
import { DayTravelModule } from '../assignment/day-travel.module';

@Module({
  imports: [
    // `BranchEntity` is registered here as well as in BranchModule because the branch import
    // resolves every SOL ID in a file with one `In(codes)` query and writes branches in chunks,
    // and BranchModule exports its services but not its repositories. Registering the same entity
    // in two modules is how TypeORM expects a repository to be shared.
    TypeOrmModule.forFeature([ProjectEntity, ProjectBranchEntity, AssessmentEntity, CallLogEntity, ClientEntity, UserEntity, ZoneEntity, BranchEntity]),
    PlatformModule,
    BranchModule,
    NotificationsModule,
    // For `GeoPrecisionService.enqueueBackfill`: the branch import hands its coarsely placed branches
    // to the precision worker the moment an import finishes. GeoModule is a leaf — it imports no
    // feature module — so this cannot close a cycle.
    GeoModule,
    // For switching an assayer's location sharing off when a cancellation ends their last job.
    // AssayerModule imports neither this module nor anything that does, so this is no cycle.
    AssayerModule,
    // Re-deciding an assayer's day after a project closure cancels the job that carried its
    // travel. A leaf (pricing + notifications only); no cycle.
    DayTravelModule,
  ],
  controllers: [ProjectController, CallLogController, BranchImportController],
  // `BranchImportJob` registers the BRANCH_IMPORT background-job kind (the Jobs foundation is global).
  providers: [ProjectService, ProjectQueryService, CallLogService, BranchImportStore, BranchImportJob],
  exports: [ProjectService, ProjectQueryService, CallLogService, TypeOrmModule],
})
export class ProjectModule {}

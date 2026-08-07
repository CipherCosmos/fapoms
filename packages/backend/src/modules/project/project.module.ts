/**
 * FAPOMS — Project Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProjectService } from './project.service';
import { ProjectQueryService } from './project-query.service';
import { ProjectController } from './project.controller';
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
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProjectEntity, ProjectBranchEntity, AssessmentEntity, CallLogEntity, ClientEntity, UserEntity, ZoneEntity]),
    PlatformModule,
    BranchModule,
    NotificationsModule,
  ],
  controllers: [ProjectController, CallLogController],
  providers: [ProjectService, ProjectQueryService, CallLogService],
  exports: [ProjectService, ProjectQueryService, CallLogService, TypeOrmModule],
})
export class ProjectModule {}

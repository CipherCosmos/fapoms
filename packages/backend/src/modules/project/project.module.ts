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
import { PlatformModule } from '../platform/platform.module';
import { BranchModule } from '../branch/branch.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProjectEntity, ProjectBranchEntity]),
    PlatformModule,
    BranchModule,
  ],
  controllers: [ProjectController],
  providers: [ProjectService, ProjectQueryService],
  exports: [ProjectService, ProjectQueryService],
})
export class ProjectModule {}

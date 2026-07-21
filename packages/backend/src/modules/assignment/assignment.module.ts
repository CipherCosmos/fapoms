/**
 * FAPOMS — Assignment Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssignmentService } from './assignment.service';
import { AssignmentController } from './assignment.controller';
import { AssignmentEntity } from './assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { HolidayModule } from '../holiday/holiday.module';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AssignmentEntity, ProjectBranchEntity]),
    HolidayModule,
    PlatformModule,
  ],
  controllers: [AssignmentController],
  providers: [AssignmentService],
  exports: [AssignmentService],
})
export class AssignmentModule {}

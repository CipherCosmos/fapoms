/**
 * FAPOMS — Assignment Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssignmentService } from './assignment.service';
import { AssignmentController } from './assignment.controller';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentCommentEntity } from './assignment-comment.entity';
import { HolidayModule } from '../holiday/holiday.module';
import { PlatformModule } from '../platform/platform.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssayerModule } from '../assayer/assayer.module';
import { ProjectModule } from '../project/project.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AssignmentEntity, AssignmentCommentEntity]),
    HolidayModule,
    PlatformModule,
    NotificationsModule,
    AssayerModule,
    ProjectModule,
  ],
  controllers: [AssignmentController],
  providers: [AssignmentService],
  exports: [AssignmentService],
})
export class AssignmentModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchedulingService } from './scheduling.service';
import { SchedulingController } from './scheduling.controller';
import { ScheduleEntity } from './schedule.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { HolidayModule } from '../holiday/holiday.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ScheduleEntity, AssignmentEntity]),
    HolidayModule,
  ],
  controllers: [SchedulingController],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}

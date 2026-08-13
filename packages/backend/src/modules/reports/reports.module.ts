import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssignmentModule } from '../assignment/assignment.module';
import { BillingEngineModule } from '../billing-engine/billing-engine.module';
import { PlanningModule } from '../planning/planning.module';
import { AssayerModule } from '../assayer/assayer.module';
import { ProjectModule } from '../project/project.module';
import { AssayerEntity } from '../assayer/assayer.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([AssayerEntity]),
    AssignmentModule,
    BillingEngineModule,
    PlanningModule,
    AssayerModule,
    ProjectModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}

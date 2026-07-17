/**
 * FAPOMS — Planning Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PlanningService } from './planning.service';
import { PlanningController } from './planning.controller';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([BranchEntity, AssayerEntity]),
  ],
  controllers: [PlanningController],
  providers: [PlanningService],
  exports: [PlanningService],
})
export class PlanningModule {}

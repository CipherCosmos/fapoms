/**
 * FAPOMS — Branch Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BranchEntity } from './branch.entity';
import { BranchService } from './branch.service';
import { BranchController } from './branch.controller';
import { ClientModule } from '../client/client.module';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from '../geo/geo.entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BranchEntity,
      GeoStateEntity,
      GeoDistrictEntity,
      GeoCityEntity,
    ]),
    ClientModule,
  ],
  controllers: [BranchController],
  providers: [BranchService],
  exports: [BranchService],
})
export class BranchModule {}

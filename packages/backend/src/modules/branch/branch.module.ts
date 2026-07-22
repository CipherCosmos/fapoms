import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BranchEntity } from './branch.entity';
import { BranchContactEntity } from './branch-contact.entity';
import { BranchDocumentEntity } from './branch-document.entity';
import { BranchService } from './branch.service';
import { BranchController } from './branch.controller';
import { ClientModule } from '../client/client.module';
import { ZoneEntity } from '../zone/zone.entity';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from '../geo/geo.entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BranchEntity,
      BranchContactEntity,
      BranchDocumentEntity,
      ZoneEntity,
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

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from './geo.entities';
import { PostGISRoutingProvider, OSRMRoutingProvider, RoutingService } from './routing.provider';
import { GeoController } from './geo.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([GeoStateEntity, GeoDistrictEntity, GeoCityEntity]),
  ],
  controllers: [GeoController],
  providers: [PostGISRoutingProvider, OSRMRoutingProvider, RoutingService],
  exports: [RoutingService, TypeOrmModule],
})
export class GeoModule {}

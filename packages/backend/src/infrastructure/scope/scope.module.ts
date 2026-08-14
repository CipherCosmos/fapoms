import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BranchEntity } from '../../modules/branch/branch.entity';
import { ZoneEntity } from '../../modules/zone/zone.entity';
import { ClientEntity } from '../../modules/client/client.entity';
import { ProjectEntity } from '../../modules/project/project.entity';
import { ScopeController } from './scope.controller';
import { RegionGuardService } from './region-guard.service';

/**
 * Serves the global scope filter's option lists, and provides `RegionGuardService` — the
 * per-entity entitlement check the realtime gateway runs before letting a socket join an
 * `assignment:`/`query:` room. HTTP-side enforcement stays where it was: plain functions
 * and a param decorator in `global-scope.ts`, with nothing to inject.
 */
@Module({
  imports: [TypeOrmModule.forFeature([BranchEntity, ZoneEntity, ClientEntity, ProjectEntity])],
  controllers: [ScopeController],
  providers: [RegionGuardService],
  exports: [RegionGuardService],
})
export class ScopeModule {}

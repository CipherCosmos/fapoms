import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BranchEntity } from '../../modules/branch/branch.entity';
import { ZoneEntity } from '../../modules/zone/zone.entity';
import { ClientEntity } from '../../modules/client/client.entity';
import { ProjectEntity } from '../../modules/project/project.entity';
import { ScopeController } from './scope.controller';
import { RegionGuardService } from './region-guard.service';

/**
 * Serves the global scope filter's option lists, and exports `RegionGuardService` — the region
 * ceiling, which has two callers:
 *
 *   - detail endpoints across the operations modules, after loading a single record;
 *   - the realtime gateway, before letting a socket join an `assignment:`/`query:` room.
 *
 * HTTP list-side enforcement stays where it was: plain functions and a param decorator in
 * `global-scope.ts`, with nothing to inject.
 *
 * `@Global()` so callers do not each need to import this module; the alternative is a scope
 * import in half the feature modules, and a module someone forgets to import is a detail route
 * that silently stops enforcing.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BranchEntity, ZoneEntity, ClientEntity, ProjectEntity])],
  controllers: [ScopeController],
  providers: [RegionGuardService],
  exports: [RegionGuardService],
})
export class ScopeModule {}

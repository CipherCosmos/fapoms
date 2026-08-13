import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BranchEntity } from '../../modules/branch/branch.entity';
import { ZoneEntity } from '../../modules/zone/zone.entity';
import { ClientEntity } from '../../modules/client/client.entity';
import { ProjectEntity } from '../../modules/project/project.entity';
import { ScopeController } from './scope.controller';
import { RegionGuardService } from './region-guard.service';

/**
 * Serves the global scope filter's option lists, and exports `RegionGuardService` — the
 * region ceiling for single-record reads, which detail endpoints across the operations
 * modules call after loading a record.
 *
 * `@Global()` so those modules do not each need to import this one; the alternative is a
 * scope import in half the feature modules, and a module someone forgets to import is a
 * detail route that silently stops enforcing.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BranchEntity, ZoneEntity, ClientEntity, ProjectEntity])],
  controllers: [ScopeController],
  providers: [RegionGuardService],
  exports: [RegionGuardService],
})
export class ScopeModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BranchEntity } from '../../modules/branch/branch.entity';
import { ZoneEntity } from '../../modules/zone/zone.entity';
import { ClientEntity } from '../../modules/client/client.entity';
import { ProjectEntity } from '../../modules/project/project.entity';
import { ScopeController } from './scope.controller';

/**
 * Serves the global scope filter's option lists. Read-only, and deliberately owns no service:
 * the enforcement it depends on lives in `global-scope.ts` as plain functions and a param
 * decorator, so there is nothing here to inject.
 */
@Module({
  imports: [TypeOrmModule.forFeature([BranchEntity, ZoneEntity, ClientEntity, ProjectEntity])],
  controllers: [ScopeController],
})
export class ScopeModule {}

/**
 * FAPOMS — User Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { PermissionEntity } from './permission.entity';
import { CapabilityEntity } from './capability.entity';
import { ResponsibilityEntity } from './responsibility.entity';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { SystemDashboardController } from './system-dashboard.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, RoleEntity, PermissionEntity, CapabilityEntity, ResponsibilityEntity]),
  ],
  controllers: [UserController, SystemDashboardController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}

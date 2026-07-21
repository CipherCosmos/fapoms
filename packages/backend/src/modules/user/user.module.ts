/**
 * FAPOMS — User Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { PermissionEntity } from './permission.entity';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { SystemDashboardController } from './system-dashboard.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, RoleEntity, PermissionEntity]),
  ],
  controllers: [UserController, SystemDashboardController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}

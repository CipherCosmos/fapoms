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
import { OperationsSnapshotService } from './operations-snapshot.service';
import { SystemDashboardController } from './system-dashboard.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, RoleEntity, PermissionEntity, CapabilityEntity, ResponsibilityEntity]),
    // For AuthService.revokeAllSessions — a password change or admin reset must end the user's
    // other sessions, otherwise a stolen session survives the very act meant to lock it out.
    // AuthModule does not depend on UserModule, so this import introduces no cycle.
    AuthModule,
  ],
  controllers: [UserController, SystemDashboardController],
  providers: [OperationsSnapshotService, UserService],
  exports: [UserService],
})
export class UserModule {}

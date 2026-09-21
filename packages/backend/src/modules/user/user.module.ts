/**
 * FAPOMS — User Module
 */

import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { PermissionEntity } from './permission.entity';
import { CapabilityEntity } from './capability.entity';
import { ResponsibilityEntity } from './responsibility.entity';
import { UserService } from './user.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AccountSetupController } from './account-setup.controller';
import { UserController } from './user.controller';
import { OperationsSnapshotService } from './operations-snapshot.service';
import { SystemDashboardController } from './system-dashboard.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, RoleEntity, PermissionEntity, CapabilityEntity, ResponsibilityEntity]),
    /*
      NotificationsModule exports `EmailService`, which `UserService` needs to send somebody the
      link that lets them choose their own password. Nothing here is imported the other way, so
      there is no cycle.
    */
    forwardRef(() => NotificationsModule),
  ],
  controllers: [UserController, SystemDashboardController, AccountSetupController],
  providers: [OperationsSnapshotService, UserService],
  exports: [UserService],
})
export class UserModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ValidationQueryMessageEntity } from './validation-query-message.entity';
import { QueryThreadService } from './query-thread.service';
import { ValidationQueryEntity } from './validation-query.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { ValidationQueryService } from './validation-query.service';
import { ValidationQueryController } from './validation-query.controller';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { DocumentModule } from '../document/document.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ValidationQueryEntity, ValidationCaseEntity, AssignmentEntity, ValidationQueryMessageEntity]),
    NotificationsModule,
    // StorageModule provides the 'StorageEngine' token injected into
    // ValidationQueryController for S3-backed chat attachment storage.
    StorageModule,
    DocumentModule,
    AuthModule,
  ],
  controllers: [ValidationQueryController],
  providers: [ValidationQueryService, QueryThreadService],
  exports: [ValidationQueryService],
})
export class ValidationQueryModule {}

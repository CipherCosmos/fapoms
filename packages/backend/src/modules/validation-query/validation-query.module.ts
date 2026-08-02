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

@Module({
  imports: [
    TypeOrmModule.forFeature([ValidationQueryEntity, ValidationCaseEntity, AssignmentEntity, ValidationQueryMessageEntity]),
    NotificationsModule,
  ],
  controllers: [ValidationQueryController],
  providers: [ValidationQueryService, QueryThreadService],
  exports: [ValidationQueryService],
})
export class ValidationQueryModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ValidationQueryEntity } from './validation-query.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { ValidationQueryService } from './validation-query.service';
import { ValidationQueryController } from './validation-query.controller';

import { AssignmentEntity } from '../assignment/assignment.entity';

import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ValidationQueryEntity, ValidationCaseEntity, AssignmentEntity]),
    NotificationsModule,
  ],
  controllers: [ValidationQueryController],
  providers: [ValidationQueryService],
  exports: [ValidationQueryService],
})
export class ValidationQueryModule {}

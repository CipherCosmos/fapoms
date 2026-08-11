import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ValidationService } from './validation.service';
import { DeskEscalationService } from './desk-escalation.service';
import { ValidationController } from './validation.controller';
import { ValidationCaseEntity } from './validation-case.entity';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { ProjectModule } from '../project/project.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ValidationCaseEntity, ValidationQueryEntity]),
    ProjectModule,
    NotificationsModule,
  ],
  controllers: [ValidationController],
  providers: [ValidationService, DeskEscalationService],
  exports: [ValidationService, DeskEscalationService],
})
export class ValidationModule {}

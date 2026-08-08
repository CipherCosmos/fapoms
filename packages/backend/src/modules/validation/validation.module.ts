import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ValidationService } from './validation.service';
import { ValidationController } from './validation.controller';
import { ValidationCaseEntity } from './validation-case.entity';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { ProjectModule } from '../project/project.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ValidationCaseEntity, ValidationQueryEntity]),
    ProjectModule,
  ],
  controllers: [ValidationController],
  providers: [ValidationService],
  exports: [ValidationService],
})
export class ValidationModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ValidationService } from './validation.service';
import { ValidationController } from './validation.controller';
import { ValidationCaseEntity } from './validation-case.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([ValidationCaseEntity, ProjectBranchEntity]),
  ],
  controllers: [ValidationController],
  providers: [ValidationService],
  exports: [ValidationService],
})
export class ValidationModule {}

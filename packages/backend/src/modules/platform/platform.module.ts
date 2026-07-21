import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BusinessRuleEntity } from './rules/business-rule.entity';
import { RuleEngine } from './rules/rule.engine';
import { WorkflowEngine } from './workflow/workflow.engine';
import { ConfigurationResolver } from './configuration/configuration.resolver';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BusinessRuleEntity])],
  providers: [RuleEngine, WorkflowEngine, ConfigurationResolver],
  exports: [TypeOrmModule, RuleEngine, WorkflowEngine, ConfigurationResolver],
})
export class PlatformModule {}

import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BusinessRuleEntity } from './rules/business-rule.entity';
import { WorkflowHistoryEntity } from './workflow/workflow-history.entity';
import { RuleEngine } from './rules/rule.engine';
import { WorkflowEngine } from './workflow/workflow.engine';
import { ConfigurationResolver } from './configuration/configuration.resolver';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BusinessRuleEntity, WorkflowHistoryEntity])],
  providers: [RuleEngine, WorkflowEngine, ConfigurationResolver, DomainEventPublisher],
  exports: [TypeOrmModule, RuleEngine, WorkflowEngine, ConfigurationResolver, DomainEventPublisher],
})
export class PlatformModule {}

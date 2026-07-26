import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DefaultConfigurationService } from './configuration/configuration.service';
import { DefaultAuthorizationService } from './authz/authorization.service';
import { DefaultEventDispatcher } from './events/event-dispatcher.service';
import { ReusableWorkflowEngine } from './workflow/workflow-engine.service';
import { TenantContextResolver } from './tenant/tenant-resolver.service';
import { PlatformAuditService } from './audit/platform-audit.service';
import { AuditLogEntity } from './audit/audit-log.entity';
import { DefaultObservabilityService } from './observability/observability.service';
import { InMemoryQueueManager } from './background/queue-manager.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AuditLogEntity,
    ]),
  ],
  providers: [
    { provide: 'ConfigurationManagerInterface', useClass: DefaultConfigurationService },
    { provide: 'AuthorizationService', useClass: DefaultAuthorizationService },
    { provide: 'EventDispatcherInterface', useClass: DefaultEventDispatcher },
    ReusableWorkflowEngine,
    TenantContextResolver,
    PlatformAuditService,
    { provide: 'StructuredLogger', useClass: DefaultObservabilityService },
    { provide: 'BackgroundQueueManager', useClass: InMemoryQueueManager },
  ],
  exports: [
    'ConfigurationManagerInterface',
    'AuthorizationService',
    'EventDispatcherInterface',
    ReusableWorkflowEngine,
    TenantContextResolver,
    PlatformAuditService,
    'StructuredLogger',
    'BackgroundQueueManager',
  ],
})
export class PlatformFoundationModule {}

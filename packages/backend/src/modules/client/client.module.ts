import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientEntity } from './client.entity';
import { ClientConfigurationEntity } from './client-configuration.entity';
import { ClientContactEntity } from './client-contact.entity';
import { ClientContractEntity } from './client-contract.entity';
import { ClientBillingEntity } from './client-billing.entity';
import { ClientBillingHistoryEntity } from './client-billing-history.entity';
import { ClientService } from './client.service';
import { ClientController } from './client.controller';

import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClientEntity,
      ClientConfigurationEntity,
      ClientContactEntity,
      ClientContractEntity,
      ClientBillingEntity,
      ClientBillingHistoryEntity,
    ]),
    PlatformModule,
  ],
  controllers: [ClientController],
  providers: [ClientService],
  exports: [ClientService],
})
export class ClientModule {}

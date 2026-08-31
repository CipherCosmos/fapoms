import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientEntity } from './client.entity';
import { ClientConfigurationEntity } from './client-configuration.entity';
import { ClientContactEntity } from './client-contact.entity';
import { ClientContractEntity } from './client-contract.entity';
import { ClientBillingEntity } from './client-billing.entity';
import { ClientService } from './client.service';
import { ClientController } from './client.controller';

import { PlatformModule } from '../platform/platform.module';
import { AssayerModule } from '../assayer/assayer.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClientEntity,
      ClientConfigurationEntity,
      ClientContactEntity,
      ClientContractEntity,
      ClientBillingEntity,
    ]),
    PlatformModule,
    // For QualificationScoreService — the "who is qualified for this partner" listing lives on
    // the client's routes but is computed by the assayer module, which owns the vetting data.
    AssayerModule,
  ],
  controllers: [ClientController],
  providers: [ClientService],
  exports: [ClientService],
})
export class ClientModule {}
